package conduitgo

import (
	"fmt"
	"math"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// Method is an HTTP method. Only these five parse; anything else is rejected.
type Method string

const (
	MethodGet    Method = "GET"
	MethodPost   Method = "POST"
	MethodPut    Method = "PUT"
	MethodPatch  Method = "PATCH"
	MethodDelete Method = "DELETE"
)

// Step is one HTTP request. Unknown fields are tolerated, matching the runtime
// parser: a typo in a step is silently ignored rather than rejected.
type Step struct {
	ID             string            `yaml:"id"`
	URL            string            `yaml:"url"`
	Method         Method            `yaml:"method"`
	Headers        map[string]string `yaml:"headers"`
	QueryTransform *string           `yaml:"query_transform"`
	BodyTransform  *string           `yaml:"body_transform"`
	Needs          []string          `yaml:"needs"`
	CacheTTL       *float64          `yaml:"cache_ttl"`
	OutputSchema   any               `yaml:"output_schema"`
}

// Conduit is a parsed definition.
type Conduit struct {
	Schema          string `yaml:"$schema"`
	Name            string `yaml:"name"`
	Description     string `yaml:"description"`
	InputSchema     any    `yaml:"input_schema"`
	OutputSchema    any    `yaml:"output_schema"`
	Steps           []Step `yaml:"steps"`
	OutputTransform string `yaml:"output_transform"`
}

// topLevelKeys is the complete set of keys accepted at the top level. Anything
// else is a parse error, so a typo like `inputschema` fails loudly.
var topLevelKeys = map[string]bool{
	"$schema": true, "name": true, "description": true,
	"input_schema": true, "output_schema": true,
	"steps": true, "output_transform": true,
}

func validMethod(m Method) bool {
	switch m {
	case MethodGet, MethodPost, MethodPut, MethodPatch, MethodDelete:
		return true
	}
	return false
}

// Parse decodes a YAML or JSON definition.
//
// The asymmetry with the reference implementation is deliberate and load-bearing:
// unknown TOP-LEVEL keys are an error, unknown STEP keys are ignored. A single
// consistent policy would break half the definitions in the corpus.
func Parse(src []byte) (*Conduit, error) {
	var probe map[string]any
	if err := yaml.Unmarshal(src, &probe); err != nil {
		return nil, fmt.Errorf("invalid conduit: %v", err)
	}
	for k := range probe {
		if !topLevelKeys[k] {
			return nil, fmt.Errorf("invalid conduit: Unrecognized key: %q", k)
		}
	}

	var c Conduit
	if err := yaml.Unmarshal(src, &c); err != nil {
		return nil, fmt.Errorf("invalid conduit: %v", err)
	}

	if c.Name == "" {
		return nil, fmt.Errorf("invalid conduit: name must not be empty")
	}
	if len(c.Steps) == 0 {
		return nil, fmt.Errorf("invalid conduit: steps must contain at least one step")
	}
	if strings.TrimSpace(c.OutputTransform) == "" {
		return nil, fmt.Errorf("invalid conduit: output_transform must not be empty")
	}

	ids := make(map[string]int, len(c.Steps))
	for i, s := range c.Steps {
		if s.ID == "" {
			return nil, fmt.Errorf("invalid conduit: step %d: id must not be empty", i)
		}
		if s.URL == "" {
			return nil, fmt.Errorf("invalid conduit: step %q: url must not be empty", s.ID)
		}
		if n, dup := ids[s.ID]; dup {
			return nil, fmt.Errorf("invalid conduit: Duplicate step id %q (steps %d and %d)", s.ID, n, i)
		}
		ids[s.ID] = i

		if s.Method == "" {
			// Assign through the index: `s` is a copy, so setting the field on it
			// would not update the stored step.
			c.Steps[i].Method = MethodGet
		} else if !validMethod(s.Method) {
			return nil, fmt.Errorf("invalid conduit: step %q: invalid method %q", s.ID, s.Method)
		}
		if s.CacheTTL != nil && (*s.CacheTTL < 0 || math.IsNaN(*s.CacheTTL)) {
			return nil, fmt.Errorf("invalid conduit: step %q: cache_ttl must be >= 0", s.ID)
		}
	}

	// needs must name a step that exists. Cycles are NOT rejected here: they
	// surface at run time, matching the reference implementation.
	for i, s := range c.Steps {
		for _, dep := range s.Needs {
			if _, ok := ids[dep]; !ok {
				return nil, fmt.Errorf("invalid conduit: needs unknown step %q", dep)
			}
		}
		_ = i
	}
	return &c, nil
}

// Wave is a set of steps that may run concurrently.
type Wave []Step

// Waves topologically groups steps: every step lands after all of its needs.
// A cycle is reported here rather than at parse time, matching the reference.
func (c *Conduit) Waves() ([]Wave, error) {
	byID := make(map[string]Step, len(c.Steps))
	for _, s := range c.Steps {
		byID[s.ID] = s
	}

	state := make(map[string]int, len(c.Steps)) // 0=unvisited 1=visiting 2=done
	order := make([]Step, 0, len(c.Steps))

	var visit func(Step) error
	visit = func(s Step) error {
		switch state[s.ID] {
		case 2:
			return nil
		case 1:
			return fmt.Errorf("Cycle detected in conduit steps involving %q", s.ID)
		}
		state[s.ID] = 1
		for _, dep := range s.Needs {
			if parent, ok := byID[dep]; ok {
				if err := visit(parent); err != nil {
					return err
				}
			}
		}
		state[s.ID] = 2
		order = append(order, s)
		return nil
	}

	for _, s := range c.Steps {
		if err := visit(s); err != nil {
			return nil, err
		}
	}

	depth := make(map[string]int, len(c.Steps))
	var waves []Wave
	for _, s := range order {
		d := 0
		if len(s.Needs) > 0 {
			for _, dep := range s.Needs {
				if dv, ok := depth[dep]; ok && dv+1 > d {
					d = dv + 1
				}
			}
		}
		depth[s.ID] = d
		for len(waves) <= d {
			waves = append(waves, Wave{})
		}
		waves[d] = append(waves[d], s)
	}
	return waves, nil
}

// stepIDs is a small helper used in tests to assert wave membership.
func (w Wave) stepIDs() []string {
	out := make([]string, len(w))
	for i, s := range w {
		out[i] = s.ID
	}
	sort.Strings(out)
	return out
}
