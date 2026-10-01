package conduitgo

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"github.com/recolabs/gnata"
)

// statusText strips the numeric prefix from an HTTP status line.
func statusText(res *http.Response) string {
	s := strings.TrimSpace(res.Status)
	if _, rest, ok := strings.Cut(s, " "); ok {
		return rest
	}
	if res.StatusCode != 0 {
		return http.StatusText(res.StatusCode)
	}
	return s
}

// evalExpr compiles and evaluates a JSONata expression against the run context.
// Compiled expressions are cached, mirroring the reference implementation.
func evalExpr(src string, ctx map[string]any) (any, error) {
	expr, err := compile(src)
	if err != nil {
		return nil, err
	}
	v, err := expr.Eval(context.Background(), ctx)
	if err != nil {
		return nil, err
	}
	// The engine returns OrderedMap for object constructors and a null sentinel
	// for undefined. Both are internal types: OrderedMap has unexported fields,
	// so it would marshal as {}. Normalize once, here, so every consumer below
	// sees plain Go types.
	return gnata.NormalizeValue(v), nil
}

var exprCache sync.Map

func compile(src string) (*gnata.Expression, error) {
	if v, ok := exprCache.Load(src); ok {
		return v.(*gnata.Expression), nil
	}
	expr, err := gnata.Compile(src)
	if err != nil {
		return nil, err
	}
	exprCache.Store(src, expr)
	return expr, nil
}

// jsonScalar renders a value the way the reference implementation's URLSearchParams
// and String(...) coercions do: numbers and booleans bare, everything else via JSON.
func jsonScalar(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case bool:
		return strconv.FormatBool(t)
	case float64:
		return trimFloat(t)
	case int:
		return strconv.Itoa(t)
	}
	if b, err := json.Marshal(v); err == nil {
		return string(b)
	}
	return fmt.Sprint(v)
}

// trimFloat renders whole floats without a trailing ".0" so a JSON number 42
// becomes "42" rather than "42.0".
func trimFloat(f float64) string {
	if f == float64(int64(f)) {
		return strconv.FormatInt(int64(f), 10)
	}
	return strconv.FormatFloat(f, 'g', -1, 64)
}

// validateAgainst checks a value against a JSON Schema, leniently.
//
// A schema that is absent, not an object, or cannot be compiled is SKIPPED rather
// than failing the run, matching the reference implementation. A nil error means
// either "valid" or "not checked".
func validateAgainst(schema any, value any) error {
	m, ok := schema.(map[string]any)
	if !ok {
		return nil // absent or not an object: no validation
	}
	compiled, err := compileSchema(m)
	if err != nil {
		errLog.Printf("[conduit] Ignoring invalid JSON schema (%v)", err)
		return nil
	}
	if err := compiled.Validate(value); err != nil {
		return err
	}
	return nil
}
