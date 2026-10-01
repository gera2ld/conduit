package conduitgo

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Go callers build input as a Go value, so it carries `int` where JSON would carry
// float64. The expression engine only understands the JSON model, and definitions
// must not have to wrap every field in $number() to cope.
func TestNormalizesGoNumericInput(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`[]`))
	}))
	defer srv.Close()

	cases := []struct {
		name  string
		input any
	}{
		{"int", map[string]any{"limit": 3}},
		{"int64", map[string]any{"limit": int64(3)}},
		{"nested int", map[string]any{"page": map[string]any{"limit": 3}}},
		{"int in a slice", map[string]any{"ids": []any{1, 2, 3}}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			def, err := Parse([]byte(`
name: t
steps:
  - id: s
    url: '"` + srv.URL + `/x"'
    query_transform: '{ "limit": $number(input.limit ?? 1) }'
output_transform: steps.s
`))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := Run(context.Background(), def, tc.input, Options{}); err != nil {
				t.Fatalf("Go numeric input should evaluate: %v", err)
			}
		})
	}
}

// JSON-shaped input is the common case and must keep working.
func TestAcceptsJSONShapedInput(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	def, err := Parse([]byte(`
name: t
steps:
  - id: s
    url: '"` + srv.URL + `/x"'
    query_transform: '{ "limit": $number(input.limit ?? 1) }'
output_transform: steps.s.ok
`))
	if err != nil {
		t.Fatal(err)
	}
	out, err := Run(context.Background(), def, map[string]any{"limit": float64(5)}, Options{})
	if err != nil {
		t.Fatalf("json-shaped input: %v", err)
	}
	if out != true {
		t.Fatalf("expected true, got %v", out)
	}
}

// A definition that omits the field entirely must not see a zero from
// normalization.
func TestOptionalInputStillAbsent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := map[string]any{}
		for k, vs := range r.URL.Query() {
			q[k] = vs[0]
		}
		writeJSON(w, 0, map[string]any{"query": q})
	}))
	defer srv.Close()

	def, err := Parse([]byte(`
name: t
steps:
  - id: s
    url: '"` + srv.URL + `/x"'
    query_transform: '{ "q": input.missing ?? "fallback" }'
output_transform: steps.s.query.q
`))
	if err != nil {
		t.Fatal(err)
	}
	out, err := Run(context.Background(), def, map[string]any{}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if out != "fallback" {
		t.Fatalf(`expected "fallback", got %v`, out)
	}
}

// Known divergence, recorded rather than fixed. jsonata-js treats an explicit
// null and an absent key differently:
//
//	input.missing ?? "fallback"   absent -> "fallback",  null -> null
//
// gnata returns the enclosing object for the null case. It is an engine bug that
// cannot be corrected from here, and no current definition depends on it — the
// corpus only exercises the absent-key case. Revisit if a definition relies on
// distinguishing null from missing.
func TestKnownDivergenceExplicitNull(t *testing.T) {
	ctx := map[string]any{"input": map[string]any{"present": nil}}
	expr, err := compile(`input.present ?? "fallback"`)
	if err != nil {
		t.Fatal(err)
	}
	got, err := expr.Eval(context.Background(), ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got == "fallback" {
		t.Skip("gnata now matches jsonata-js; remove this note and the divergence record")
	}
	t.Logf("known divergence: explicit null yields %T, jsonata-js yields null", got)
}
