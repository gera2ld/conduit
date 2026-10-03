package conduitgo

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The fixtures are language-neutral: the same directories the TypeScript
// implementation runs. This harness is the Go half of that contract.

const baseURLToken = "{{base_url}}"

type routeSpec struct {
	Path        string          `json:"path"`
	Kind        string          `json:"kind"`
	Status      int             `json:"status"`
	ContentType string          `json:"contentType"`
	Body        json.RawMessage `json:"body"`
	DelayMs     int             `json:"delayMs"`
}

type serverSpec struct {
	Routes []routeSpec `json:"routes"`
}

type fixture struct {
	name        string
	dir         string
	source      []byte
	input       any
	server      serverSpec
	expect      any
	hasExpect   bool
	expectError string
	slow        bool
	invalidDef  bool
	env         map[string]string
	headers     map[string]string
	sharedCache bool
	runs        int
}

func replaceToken(s, base string) string { return strings.ReplaceAll(s, baseURLToken, base) }

func fixturesDir(t *testing.T) string {
	t.Helper()
	abs, err := filepath.Abs("../../spec/fixtures")
	if err != nil {
		t.Fatal(err)
	}
	return abs
}

func loadFixtures(t *testing.T, includeSlow bool) []fixture {
	t.Helper()
	dir := fixturesDir(t)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read fixtures: %v", err)
	}

	var out []fixture
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		f := loadFixture(t, filepath.Join(dir, e.Name()))
		if f.slow && !includeSlow {
			continue
		}
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out
}

func readJSON(t *testing.T, path string) (any, bool) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	return v, true
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func loadFixture(t *testing.T, dir string) fixture {
	t.Helper()
	name := filepath.Base(dir)
	src, err := os.ReadFile(filepath.Join(dir, "conduit.yaml"))
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	f := fixture{name: name, dir: dir, source: src, runs: 1}

	if in, ok := readJSON(t, filepath.Join(dir, "input.json")); ok {
		f.input = in
	} else {
		f.input = map[string]any{}
	}
	if srv, ok := readJSON(t, filepath.Join(dir, "server.json")); ok {
		m, _ := srv.(map[string]any)
		raw, _ := json.Marshal(m)
		_ = json.Unmarshal(raw, &f.server)
	}
	if exp, ok := readJSON(t, filepath.Join(dir, "expect.json")); ok {
		f.expect, f.hasExpect = exp, true
	}
	if b, err := os.ReadFile(filepath.Join(dir, "expect-error.txt")); err == nil {
		f.expectError = strings.TrimSpace(string(b))
	}
	if !f.hasExpect && f.expectError == "" {
		t.Fatalf("%s: needs expect.json or expect-error.txt", name)
	}
	f.slow = exists(filepath.Join(dir, "slow"))
	f.invalidDef = exists(filepath.Join(dir, "invalid-definition"))
	f.sharedCache = exists(filepath.Join(dir, "shared-cache"))
	if env, ok := readJSON(t, filepath.Join(dir, "env.json")); ok {
		m, _ := env.(map[string]any)
		f.env = map[string]string{}
		for k, v := range m {
			f.env[k] = fmt.Sprint(v)
		}
	}
	if raw, ok := readJSON(t, filepath.Join(dir, "headers.json")); ok {
		m, _ := raw.(map[string]any)
		f.headers = map[string]string{}
		for k, v := range m {
			f.headers[k] = fmt.Sprint(v)
		}
	}
	if b, err := os.ReadFile(filepath.Join(dir, "runs")); err == nil {
		if n, convErr := strconv.Atoi(strings.TrimSpace(string(b))); convErr == nil && n > 0 {
			f.runs = n
		}
	}
	return f
}

// serve stands up the routes a fixture declares, mirroring the route kinds the
// TypeScript harness provides.
func serve(t *testing.T, spec serverSpec) *httptest.Server {
	t.Helper()
	counters := map[string]int{}

	mux := http.NewServeMux()
	for _, route := range spec.Routes {
		r := route
		mux.HandleFunc(r.Path, func(w http.ResponseWriter, req *http.Request) {
			if r.DelayMs > 0 {
				time.Sleep(time.Duration(r.DelayMs) * time.Millisecond)
			}
			switch r.Kind {
			case "echo":
				// Reflect what the request actually carried, so a transform can be
				// asserted on the wire.
				var body any
				raw := readAll(req)
				if raw != "" {
					if err := json.Unmarshal([]byte(raw), &body); err != nil {
						body = raw
					}
				}
				writeJSON(w, r.Status, map[string]any{
					"method":  req.Method,
					"path":    req.URL.Path,
					"query":   queryToAny(req),
					"headers": headerToAny(req),
					"body":    body,
				})
			case "counter":
				counters[r.Path]++
				writeJSON(w, r.Status, map[string]any{"hits": counters[r.Path]})
			default:
				status := r.Status
				if status == 0 {
					status = 200
				}
				ct := r.ContentType
				var payload []byte
				if len(r.Body) > 0 {
					if r.ContentType == "" && json.Valid(r.Body) && strings.HasPrefix(strings.TrimSpace(string(r.Body)), "{") {
						payload = r.Body
						ct = "application/json"
					} else {
						payload = []byte(strings.Trim(string(r.Body), `"`))
						if ct == "" {
							ct = "text/plain"
						}
					}
				}
				if ct != "" {
					w.Header().Set("content-type", ct)
				}
				w.WriteHeader(status)
				w.Write(payload)
			}
		})
	}
	return httptest.NewServer(mux)
}

func readAll(req *http.Request) string {
	if req.Body == nil {
		return ""
	}
	buf := make([]byte, 0, 512)
	tmp := make([]byte, 512)
	for {
		n, err := req.Body.Read(tmp)
		buf = append(buf, tmp[:n]...)
		if err != nil {
			break
		}
	}
	return string(buf)
}

// queryToAny keeps a repeated key as an array so `tag[]=a&tag[]=b` is assertable.
func queryToAny(req *http.Request) map[string]any {
	out := map[string]any{}
	for k, vs := range req.URL.Query() {
		if len(vs) > 1 {
			items := make([]any, len(vs))
			for i, v := range vs {
				items[i] = v
			}
			out[k] = items
			continue
		}
		out[k] = vs[0]
	}
	return out
}

func headerToAny(req *http.Request) map[string]any {
	out := map[string]any{}
	for k := range req.Header {
		out[strings.ToLower(k)] = req.Header.Get(k)
	}
	return out
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	if status == 0 {
		status = 200
	}
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// runFixture executes one fixture and reports whether it matched.
func runFixture(t *testing.T, f fixture) (bool, string) {
	t.Helper()
	srv := serve(t, f.server)
	defer srv.Close()

	src := strings.ReplaceAll(string(f.source), baseURLToken, srv.URL)

	def, err := Parse([]byte(src))
	if err != nil {
		if f.expectError != "" && strings.Contains(err.Error(), f.expectError) {
			return true, "parse rejected as expected"
		}
		return false, fmt.Sprintf("parse failed: %v", err)
	}

	opts := Options{Env: f.env, Headers: f.headers}
	if f.sharedCache {
		opts.Cache = NewCache()
	}

	var last any
	for i := 0; i < f.runs; i++ {
		last, err = Run(t.Context(), def, f.input, opts)
		if err != nil {
			if f.expectError != "" {
				if strings.Contains(err.Error(), f.expectError) {
					return true, "error matched"
				}
				return false, fmt.Sprintf("expected error containing %q, got %q", f.expectError, err.Error())
			}
			return false, fmt.Sprintf("unexpected error: %v", err)
		}
	}
	if f.expectError != "" {
		return false, fmt.Sprintf("expected error containing %q, but the run succeeded", f.expectError)
	}
	if !deepEqual(last, f.expect) {
		return false, fmt.Sprintf("expected %s, got %s", canonical(f.expect), canonical(last))
	}
	return true, "matched"
}

// deepEqual compares canonical JSON, so key order never decides the result.
func deepEqual(a, b any) bool { return canonical(a) == canonical(b) }

func canonical(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprint(v)
	}
	return string(b)
}
