package conduitgo

import (
	"os"
	"strings"
	"testing"
)

// TestConformance runs every fixture in spec/fixtures against this
// implementation. The TypeScript suite runs the same directories, so a
// divergence here means the two implementations disagree about the format.
func TestConformance(t *testing.T) {
	includeSlow := os.Getenv("CONDUIT_SPEC_SLOW") == "1"
	fixtures := loadFixtures(t, includeSlow)
	if len(fixtures) == 0 {
		t.Fatal("no fixtures loaded")
	}

	var failed []string
	passed := 0
	for _, f := range fixtures {
		if f.invalidDef {
			// Handled by TestSchemaAsymmetry, which asserts both parsers agree.
			continue
		}
		ok, detail := runFixture(t, f)
		if ok {
			passed++
			continue
		}
		failed = append(failed, "  "+f.name+": "+detail)
	}

	t.Logf("%d/%d fixtures passed", passed, passed+len(failed))
	for _, line := range failed {
		t.Error(strings.TrimPrefix(line, "  "))
	}
}

// TestSchemaAsymmetry pins the one rule that is easy to get wrong: unknown
// TOP-LEVEL keys are rejected, unknown STEP keys are silently ignored.
func TestSchemaAsymmetry(t *testing.T) {
	cases := []struct {
		name    string
		src     string
		wantErr string
	}{
		{
			name:    "unknown top-level key is rejected",
			src:     "name: x\ntypo_key: true\nsteps:\n  - id: s\n    url: u\noutput_transform: '1'\n",
			wantErr: "Unrecognized key",
		},
		{
			name:    "duplicate step ids are rejected",
			src:     "name: x\nsteps:\n  - id: a\n    url: u\n  - id: a\n    url: u\noutput_transform: '1'\n",
			wantErr: "Duplicate step id",
		},
		{
			name:    "needs naming an unknown step is rejected",
			src:     "name: x\nsteps:\n  - id: a\n    url: u\n    needs: [ghost]\noutput_transform: '1'\n",
			wantErr: "needs unknown step",
		},
		{
			name:    "empty name is rejected",
			src:     "name: \"\"\nsteps:\n  - id: s\n    url: u\noutput_transform: '1'\n",
			wantErr: "name must not be empty",
		},
		{
			name:    "no steps is rejected",
			src:     "name: x\nsteps: []\noutput_transform: '1'\n",
			wantErr: "at least one step",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Parse([]byte(tc.src))
			if err == nil {
				t.Fatalf("expected an error containing %q, got none", tc.wantErr)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("expected error containing %q, got %q", tc.wantErr, err.Error())
			}
		})
	}

	// The counterpart: an unknown key on a step is accepted and ignored.
	t.Run("unknown step key is ignored", func(t *testing.T) {
		def, err := Parse([]byte(
			"name: x\nsteps:\n  - id: s\n    url: u\n    bogus_key: 1\noutput_transform: '1'\n"))
		if err != nil {
			t.Fatalf("unknown step key should be ignored, got %v", err)
		}
		if len(def.Steps) != 1 || def.Steps[0].ID != "s" {
			t.Fatalf("step not parsed: %+v", def.Steps)
		}
	})

	t.Run("method defaults to GET", func(t *testing.T) {
		def, err := Parse([]byte("name: x\nsteps:\n  - id: s\n    url: u\noutput_transform: '1'\n"))
		if err != nil {
			t.Fatal(err)
		}
		if def.Steps[0].Method != MethodGet {
			t.Fatalf("expected GET, got %q", def.Steps[0].Method)
		}
	})

	t.Run("forward needs reference is allowed", func(t *testing.T) {
		if _, err := Parse([]byte(
			"name: x\nsteps:\n  - id: a\n    url: u\n    needs: [b]\n  - id: b\n    url: u\noutput_transform: '1'\n")); err != nil {
			t.Fatalf("forward reference should parse: %v", err)
		}
	})

	t.Run("invalid method is rejected", func(t *testing.T) {
		if _, err := Parse([]byte(
			"name: x\nsteps:\n  - id: s\n    url: u\n    method: HEAD\noutput_transform: '1'\n")); err == nil {
			t.Fatal("expected HEAD to be rejected")
		}
	})

	t.Run("negative cache_ttl is rejected", func(t *testing.T) {
		if _, err := Parse([]byte(
			"name: x\nsteps:\n  - id: s\n    url: u\n    cache_ttl: -5\noutput_transform: '1'\n")); err == nil {
			t.Fatal("expected negative cache_ttl to be rejected")
		}
	})
}

// TestWaveOrdering checks the concurrency grouping the format promises.
func TestWaveOrdering(t *testing.T) {
	def, err := Parse([]byte(
		"name: x\nsteps:\n" +
			"  - id: a\n    url: u\n" +
			"  - id: b\n    url: u\n" +
			"  - id: c\n    url: u\n    needs: [a, b]\n" +
			"output_transform: '1'\n"))
	if err != nil {
		t.Fatal(err)
	}
	waves, err := def.Waves()
	if err != nil {
		t.Fatal(err)
	}
	if len(waves) != 2 {
		t.Fatalf("expected 2 waves, got %d", len(waves))
	}
	if got := waves[0].stepIDs(); len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Fatalf("wave 0 should be [a b], got %v", got)
	}
	if got := waves[1].stepIDs(); len(got) != 1 || got[0] != "c" {
		t.Fatalf("wave 1 should be [c], got %v", got)
	}
}

// TestCycleDetection confirms a cycle is a run-time error, not a parse error.
func TestCycleDetection(t *testing.T) {
	def, err := Parse([]byte(
		"name: cycle\nsteps:\n" +
			"  - id: a\n    url: u\n    needs: [b]\n" +
			"  - id: b\n    url: u\n    needs: [a]\n" +
			"output_transform: '1'\n"))
	if err != nil {
		t.Fatalf("a cycle must parse, got %v", err)
	}
	if _, err := def.Waves(); err == nil {
		t.Fatal("expected a cycle error")
	} else if !strings.Contains(err.Error(), "Cycle detected in conduit steps") {
		t.Fatalf("unexpected error: %v", err)
	}
}
