# conduit (Go)

A Go implementation of [conduit](../../README.md) — a declarative composition of HTTP
calls, described by a YAML or JSON document.

The same definitions run unchanged under the TypeScript and Go implementations. Both
execute the shared conformance corpus in [`spec/`](../../spec), so behavior is pinned
rather than documented and hoped for.

## Install

```sh
go get github.com/gera2ld/conduit/packages/conduit-go
```

The module is versioned in step with the npm package. To pin one, use its
`packages/conduit-go/vX.Y.Z` tag:

```sh
go get github.com/gera2ld/conduit/packages/conduit-go@v0.2.0
```

## Usage

```go
package main

import (
	"context"
	"encoding/json"
	"fmt"

	conduit "github.com/gera2ld/conduit/packages/conduit-go"
)

func main() {
	def, err := conduit.Parse([]byte(`
name: user_posts
steps:
  - id: user
    url: '"https://jsonplaceholder.typicode.com/users/" & $string(input.user_id)'
  - id: posts
    needs: [user]
    url: '"https://jsonplaceholder.typicode.com/posts"'
    query_transform: '{ "userId": steps.user.id }'
output_transform: '{ "name": steps.user.name, "titles": steps.posts.title[] }'
`))
	if err != nil {
		panic(err)
	}

	out, err := conduit.Run(
		context.Background(),
		def,
		map[string]any{"user_id": 1},
		conduit.Options{},
	)
	if err != nil {
		panic(err)
	}
	b, _ := json.MarshalIndent(out, "", "  ")
	fmt.Println(string(b))
}
```

`Parse` takes the definition source; `Run` executes it against an input and returns
whatever `output_transform` produced. A definition can be a local file, a remote URL,
or anything that yields YAML or JSON bytes.

### Options

| Field   | Purpose                                                                   |
| ------- | ------------------------------------------------------------------------- |
| `Env`   | Environment variables exposed to expressions as `env`. Defaults to empty. |
| `Cache` | A `*Cache` shared across runs, enabling `cache_ttl` to persist.           |

```go
cache := conduitgo.NewCache()
out, err := conduitgo.Run(ctx, def, input, conduitgo.Options{Cache: cache})
```

With no `Cache`, each run gets a throwaway one, so `cache_ttl` still deduplicates
identical `GET`s within a single run.

## Behavioral notes

These match the TypeScript implementation, and are pinned by the corpus. A few are
surprising enough to be worth stating outright.

- **Unknown step keys are silently ignored; unknown top-level keys are an error.** A
  typo inside a step (`cacheTTL: 300`) fails quietly. One at the top level fails loudly.
- **`needs` is required for data flow, not just ordering.** Steps in the same wave run
  concurrently, so a step reading `steps.other` without listing `other` in `needs` sees
  nothing.
- **A regex pattern must be a literal** — `$replace(s, /[0-9]/, "")`, not
  `$replace(s, "[0-9]", "")`. The quoted form matches the string literally and silently
  does nothing.
- **An unset `env` variable reaches a header as the literal text `undefined`**, so
  append `?? ""` to guard. This is replicated deliberately; see the corpus case
  `unset-env-var-becomes-literal-undefined`.
- **The request timeout is a fixed 10s** with no per-step override.
- **The cache key ignores headers**, so a response cached for one set of credentials
  can be served to another. Do not set `cache_ttl` on a URL whose response varies by
  auth.

Regular expressions are the one area that is _not_ fully portable: `$match` reports the
position as `start`/`end` here and as `index` in `jsonata-js`, and this
implementation's RE2 engine rejects lookahead and backreferences. See
[`spec/jsonata-parity.md`](../../spec/jsonata-parity.md) for the measurements.

## Documentation

- Format reference: [`docs/syntax.md`](../../docs/syntax.md)
- Conformance corpus and what is authoritative: [`spec/README.md`](../../spec/README.md)

## License

MIT
