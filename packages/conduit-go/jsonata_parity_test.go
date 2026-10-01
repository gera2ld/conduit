package conduitgo

import (
	"context"
	_ "embed"
	"encoding/json"
	"testing"

	"github.com/recolabs/gnata"
)

// parityJSON is embedded rather than read from ../../spec at test time.
//
// Go's test cache only tracks files inside the package directory, so a test that
// read the shared corpus from outside would silently return a STALE PASS after
// the corpus changed. Embedding puts the data in the package, so `go test ./...`
// alone is always correct.
//
// The copy under testdata/ is kept in sync by TestParityCopyInSync, which runs
// in the TypeScript suite because bun does not cache test results.
//
//go:embed testdata/parity.json
var parityJSON []byte

type parityCase struct {
	Expr string `json:"expr"`
	Want string `json:"got"`
}

type parityCorpus struct {
	Ctx map[string]any `json:"ctx"`
	Out []parityCase   `json:"out"`
}

func loadParity(t *testing.T) parityCorpus {
	t.Helper()
	var c parityCorpus
	if err := json.Unmarshal(parityJSON, &c); err != nil {
		t.Fatalf("parse embedded parity corpus: %v", err)
	}
	if len(c.Out) == 0 {
		t.Fatal("embedded parity corpus is empty")
	}
	return c
}

// TestJSONataParity is the gate on the expression engine choice. Every case is a
// construct the conduit corpus depends on, and `want` is what jsonata-js -- the
// TypeScript implementation's engine -- returns.
//
// The engine is not interchangeable. Measured against this corpus:
//
//	github.com/recolabs/gnata              17/17
//	github.com/darius-lesch/jsonata-go/v2   errors on undefined paths
//	github.com/tiaanduplessis/jsonata-go    unquoted keys become literals
//
// Both rejected engines advertise full jsonata-js 2.2.2 parity. Switching
// engines will fail this test rather than silently changing conduit behavior.
func TestJSONataParity(t *testing.T) {
	c := loadParity(t)
	for _, tc := range c.Out {
		t.Run(tc.Expr, func(t *testing.T) {
			expr, err := gnata.Compile(tc.Expr)
			if err != nil {
				t.Fatalf("compile: %v", err)
			}
			got, err := expr.Eval(context.Background(), c.Ctx)
			if err != nil {
				t.Fatalf("eval: %v", err)
			}
			enc, err := json.Marshal(got)
			if err != nil {
				t.Fatalf("encode: %v", err)
			}
			if string(enc) != tc.Want {
				t.Errorf("divergence from jsonata-js\n  got:  %s\n  want: %s", enc, tc.Want)
			}
		})
	}
}
