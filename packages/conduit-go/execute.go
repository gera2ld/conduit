package conduitgo

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

// requestTimeout is fixed at 10s. The reference implementation inherits this from
// its HTTP helper and offers no per-step override, so neither does this one.
const requestTimeout = 10 * time.Second

// CacheEntry is a cached GET response.
type CacheEntry struct {
	Expires time.Time
	Data    any
}

// inflightResult carries the outcome of a request another step may be awaiting.
type inflightResult struct {
	data any
	err  error
}

// Cache maps a cache key to its entry, and tracks in-flight requests so
// concurrent steps requesting the same URL share one round trip. The caller owns
// it, so entries can be shared across runs.
type Cache struct {
	mu       sync.Mutex
	entries  map[string]CacheEntry
	inflight map[string]chan inflightResult
}

func NewCache() *Cache {
	return &Cache{entries: map[string]CacheEntry{}, inflight: map[string]chan inflightResult{}}
}

func (c *Cache) get(key string) (CacheEntry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	return e, ok
}

func (c *Cache) set(key string, e CacheEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = e
}

func (c *Cache) delete(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, key)
}

// joinInflight atomically claims a key or joins the request already in flight.
// Checking and setting separately would let two concurrent steps both miss.
func (c *Cache) joinInflight(key string) (ch chan inflightResult, owner bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if existing, ok := c.inflight[key]; ok {
		return existing, false
	}
	ch = make(chan inflightResult, 1)
	c.inflight[key] = ch
	return ch, true
}

func (c *Cache) inflightDelete(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.inflight, key)
}

// Options configures a run.
type Options struct {
	Env   map[string]string
	Cache *Cache
}

// Run executes a definition and returns the value output_transform produced.
func Run(ctx context.Context, c *Conduit, input any, opts Options) (any, error) {
	env := opts.Env
	if env == nil {
		env = map[string]string{}
	}
	cache := opts.Cache
	if cache == nil {
		cache = NewCache()
	}

	// Callers build the input as a Go value, so it can carry `int`, `int64` and
	// friends. The expression engine only understands JSON's types, where every
	// number is a float64, so normalize once here rather than making every
	// definition defensive with $number() around each field.
	input = normalizeNumbers(input)

	if err := validateAgainst(c.InputSchema, input); err != nil {
		return nil, fmt.Errorf("Conduit %q input: %v", c.Name, err)
	}

	steps := map[string]any{}
	execCtx := map[string]any{"input": input, "steps": steps, "env": toAnyMap(env)}

	waves, err := c.Waves()
	if err != nil {
		return nil, err
	}

	for _, wave := range waves {
		var wg sync.WaitGroup
		// Steps in a wave run concurrently, so writes to the shared steps map
		// need a lock. The reference implementation gets this for free because
		// JavaScript is single-threaded.
		var mu sync.Mutex
		errs := make([]error, len(wave))
		for i, step := range wave {
			wg.Add(1)
			go func(i int, s Step) {
				defer wg.Done()
				data, err := runStep(ctx, s, execCtx, cache)
				if err != nil {
					errs[i] = err
					return
				}
				if verr := validateAgainst(s.OutputSchema, data); verr != nil {
					errs[i] = fmt.Errorf("Step %q output validation failed: %v", s.ID, verr)
					return
				}
				mu.Lock()
				steps[s.ID] = data
				mu.Unlock()
			}(i, step)
		}
		wg.Wait()
		for _, err := range errs {
			if err != nil {
				return nil, err
			}
		}
	}

	out, err := evalExpr(c.OutputTransform, execCtx)
	if err != nil {
		return nil, fmt.Errorf("Conduit %q output_transform failed: %v", c.Name, err)
	}
	if err := validateAgainst(c.OutputSchema, out); err != nil {
		return nil, fmt.Errorf("Conduit %q output: %v", c.Name, err)
	}
	return out, nil
}

func toAnyMap(m map[string]string) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// runStep performs one request. Steps within a wave are independent, so the
// context map is read-only here; only the caller writes results back.
func runStep(ctx context.Context, s Step, execCtx map[string]any, cache *Cache) (any, error) {
	rawURL, err := evalExpr(s.URL, execCtx)
	if err != nil {
		return nil, fmt.Errorf("Step %q: url: %v", s.ID, err)
	}
	urlStr, ok := rawURL.(string)
	if !ok || urlStr == "" {
		return nil, fmt.Errorf("Step %q: url must evaluate to a non-empty string", s.ID)
	}

	var query map[string]any
	if s.QueryTransform != nil {
		q, err := evalExpr(*s.QueryTransform, execCtx)
		if err != nil {
			return nil, fmt.Errorf("Step %q: query_transform: %v", s.ID, err)
		}
		if q != nil {
			m, ok := q.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("Step %q: query_transform must evaluate to an object", s.ID)
			}
			query = m
		}
	}

	// GET-only opt-in cache. A key of 0 (or absent) disables caching.
	ttl := 0.0
	if s.Method == MethodGet && s.CacheTTL != nil {
		ttl = *s.CacheTTL
	}
	var key string
	if ttl > 0 {
		key = cacheKey(s.Method, urlStr, query)
		if hit, ok := cache.get(key); ok {
			if time.Now().Before(hit.Expires) {
				return hit.Data, nil
			}
			cache.delete(key)
		}
	}

	// Steps in one wave run concurrently and cannot see each other's responses,
	// so a shared cache entry only helps if an in-flight request is also shared.
	// Without this, two identical GETs in the same wave would each issue their
	// own request and the second would miss.
	var done chan inflightResult
	if key != "" {
		var owner bool
		done, owner = cache.joinInflight(key)
		if !owner {
			r := <-done
			if r.err != nil {
				return nil, r.err
			}
			return r.data, nil
		}
		defer cache.inflightDelete(key)
	}

	data, err := fetch(ctx, s, urlStr, query, execCtx)
	if done != nil {
		done <- inflightResult{data: data, err: err}
		close(done)
	}

	if err != nil {
		return nil, err
	}
	if key != "" {
		cache.set(key, CacheEntry{Expires: time.Now().Add(time.Duration(ttl * float64(time.Second))), Data: data})
	}
	return data, nil
}

func fetch(ctx context.Context, s Step, urlStr string, query map[string]any, execCtx map[string]any) (any, error) {
	parsed, err := url.Parse(urlStr)
	if err != nil {
		return nil, fmt.Errorf("Step %q failed (%s %s): %v", s.ID, s.Method, urlStr, err)
	}
	// query_transform REPLACES the whole query string, including any the URL
	// already carried. Start from empty rather than merging.
	if len(query) > 0 {
		q := url.Values{}
		for k, v := range query {
			// An array value repeats the key with a `[]` suffix: tag[]=a&tag[]=b
			key := k
			if arr, ok := v.([]any); ok {
				if !strings.HasSuffix(key, "[]") {
					key += "[]"
				}
				for _, item := range arr {
					q.Add(key, jsonScalar(item))
				}
				continue
			}
			q.Add(key, jsonScalar(v))
		}
		parsed.RawQuery = q.Encode()
	}

	var body io.Reader
	var jsonBody any
	if s.Method != MethodGet && s.BodyTransform != nil {
		jsonBody, err = evalExpr(*s.BodyTransform, execCtx)
		if err != nil {
			return nil, fmt.Errorf("Step %q: body_transform: %v", s.ID, err)
		}
		if jsonBody != nil {
			buf, mErr := json.Marshal(jsonBody)
			if mErr != nil {
				return nil, fmt.Errorf("Step %q: body_transform: %v", s.ID, mErr)
			}
			body = bytes.NewReader(buf)
		}
	}

	reqCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()

	method := string(s.Method)
	if method == "" {
		method = string(MethodGet)
	}
	req, err := http.NewRequestWithContext(reqCtx, method, parsed.String(), body)
	if err != nil {
		return nil, fmt.Errorf("Step %q failed (%s %s): %v", s.ID, method, urlStr, err)
	}
	for name, src := range s.Headers {
		v, eErr := evalExpr(src, execCtx)
		if eErr != nil {
			return nil, fmt.Errorf("Step %q: header %q: %v", s.ID, name, eErr)
		}
		// An expression evaluating to undefined must reach the server as the
		// literal text "undefined", because the reference implementation coerces
		// header values with String(...) and String(undefined) is "undefined".
		// The corpus pins this, so it is replicated deliberately rather than
		// "fixed" here — see unset-env-var-becomes-literal-undefined.
		if v == nil {
			req.Header.Set(name, "undefined")
			continue
		}
		req.Header.Set(name, jsonScalar(v))
	}
	if jsonBody != nil {
		req.Header.Set("content-type", "application/json")
	}

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("Step %q failed (%s %s): %v", s.ID, method, urlStr, err)
	}
	defer res.Body.Close()

	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, fmt.Errorf("Step %q failed (%s %s): %v", s.ID, method, urlStr, err)
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		// Match the reference implementation, which reports the bare status text
		// (e.g. "Not Found") rather than Go's "404 Not Found".
		return nil, fmt.Errorf("Step %q failed (%s %s): %s", s.ID, method, urlStr, statusText(res))
	}
	// Parse as JSON when possible, otherwise keep the raw text.
	var data any
	if err := json.Unmarshal(raw, &data); err == nil {
		return data, nil
	}
	return string(raw), nil
}

// cacheKey is method + url + query sorted by key. Headers are deliberately NOT
// part of the key.
func cacheKey(m Method, urlStr string, query map[string]any) string {
	if len(query) == 0 {
		return fmt.Sprintf("%s %s", m, urlStr)
	}
	keys := make([]string, 0, len(query))
	for k := range query {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var parts []string
	for _, k := range keys {
		v := query[k]
		if arr, ok := v.([]any); ok {
			key := k
			if !strings.HasSuffix(key, "[]") {
				key += "[]"
			}
			for _, item := range arr {
				parts = append(parts, url.QueryEscape(key)+"="+url.QueryEscape(jsonScalar(item)))
			}
			continue
		}
		parts = append(parts, url.QueryEscape(k)+"="+url.QueryEscape(jsonScalar(v)))
	}
	return fmt.Sprintf("%s %s?%s", m, urlStr, strings.Join(parts, "&"))
}
