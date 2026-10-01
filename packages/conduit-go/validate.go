package conduitgo

import (
	"bytes"
	"encoding/json"
	"log"
	"os"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

// errLog carries the "ignoring invalid schema" warning. Progress and warnings go
// to stderr so a piped stdout stays pure data, matching the reference.
var errLog = log.New(os.Stderr, "", 0)

var (
	schemaMu    sync.Mutex
	schemaCache = map[string]*jsonschema.Schema{}
)

// compileSchema compiles and caches a schema, so an uncompilable schema is only
// reported once rather than on every step.
func compileSchema(m map[string]any) (*jsonschema.Schema, error) {
	raw, err := json.Marshal(m)
	if err != nil {
		return nil, err
	}
	key := string(raw)

	schemaMu.Lock()
	defer schemaMu.Unlock()
	if s, ok := schemaCache[key]; ok {
		return s, nil
	}

	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}

	// Each schema is registered under a unique URL so concurrently compiled
	// schemas cannot collide in the shared resource map.
	c := jsonschema.NewCompiler()
	loc := "https://conduit.local/schema/" + itoa(len(schemaCache)) + ".json"
	if err := c.AddResource(loc, doc); err != nil {
		return nil, err
	}
	s, err := c.Compile(loc)
	if err != nil {
		return nil, err
	}
	schemaCache[key] = s
	return s, nil
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
