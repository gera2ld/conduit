# Conduit specification

This directory is the **language-neutral** definition of what a conduit is and how it
behaves. It exists so a second implementation — Go, or anything else — can be written
against a contract rather than against the TypeScript source.

Nothing here imports the TypeScript implementation's behavior implicitly: the
`harness.ts` runner and the fixtures are the contract.

## What is authoritative

| Concern                                         | Authority                                                                                             |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Which fields exist, and their types             | [`schema/conduit.schema.json`](schema/conduit.schema.json) + [`../docs/syntax.md`](../docs/syntax.md) |
| What a conduit actually _does_                  | The fixtures in `fixtures/` — behavior beats prose                                                    |
| How the TypeScript implementation behaves today | `../packages/conduit-ts/src/` — the reference, not the contract                                       |

Where prose and fixtures disagree, **the fixtures win** and the prose is a bug. Where
the schema and the runtime parser disagree, `spec/conformance.test.ts` fails the build.

## Why a corpus rather than just docs

Several behaviors of this format are load-bearing but were never written down as intent.
They are simply what the code does, and a second implementation would naturally "fix"
them into something different:

- Unknown keys are rejected at the **top level** but **silently dropped on a step**.
- The request timeout is a fixed 10 seconds with no field to override it.
- An unset environment variable reaches a header as the literal text `undefined`.
- The response cache key ignores headers, so a cached entry can cross credentials.
- Every request carries only the headers the definition declares, plus whatever the
  caller passed on the run; the step's own headers win.
- A JSONata projection collapses to a scalar on exactly one match.
- A bare `{}` does not map over a sequence.
- Hyphenated keys need `$lookup()`; dot and bracket notation return the enclosing object.

Each of those has a fixture. That is the point: the corpus is what makes a second
implementation safe to write, and it is the deliverable that pays off even if the second
implementation never arrives.

A second implementation also has to evaluate expressions compatibly. The engines are not
interchangeable — see [jsonata-parity.md](jsonata-parity.md) for the measurements and the
one engine that passes.

## Layout

```
spec/
  schema/conduit.schema.json   JSON Schema 2020-12 for a definition (published to dist)
  harness.ts                   fixture loader + serve/execute/compare runner
  conformance.test.ts          corpus runner + schema-vs-runtime agreement
  parity.test.ts               expression-engine parity, both directions
  jsonata-parity/              recorded jsonata-js results (generated)
  jsonata-parity.md            which expression engine a second implementation must use
  fixtures/<case>/             one directory per case
```

A case is a directory of plain data:

| File                   | Required | Purpose                                                          |
| ---------------------- | -------- | ---------------------------------------------------------------- |
| `conduit.yaml`         | yes      | The definition. `{{base_url}}` is replaced with the live origin  |
| `server.json`          | no       | Routes to serve for this case (see below)                        |
| `input.json`           | no       | Input payload; defaults to `{}`                                  |
| `headers.json`         | no       | Headers added to every request in the run                        |
| `expect.json`          | either   | Expected output, deep-compared with key order ignored            |
| `expect-error.txt`     | either   | Substring the error message must contain                         |
| `env.json`             | no       | Environment for the run, replacing the harness default entirely  |
| `slow`                 | no       | Presence excludes the case from the default run                  |
| `invalid-definition`   | no       | The definition is intentionally malformed; skip in schema checks |
| `shared-cache`, `runs` | no       | Run N times in one fixture against a shared cache                |

`expect.json` and `expect-error.txt` are mutually exclusive; exactly one is required.

### Route kinds

`server.json` declares real HTTP responses, because HTTP is the subject under test — a
pure fixture could not exercise timeouts, non-2xx failures, or header coercion.

```json
{
  "routes": [
    { "path": "/user", "body": { "name": "Gerald" } },
    { "path": "/text", "body": "plain text" },
    { "path": "/gone", "status": 404, "body": { "error": "missing" } },
    { "path": "/echo", "kind": "echo" },
    { "path": "/hits", "kind": "counter" },
    { "path": "/slow", "delayMs": 11000, "body": { "late": true } }
  ]
}
```

- **`static`** (default) — fixed response. An object body is sent as JSON, a string
  verbatim. `status` and `contentType` are optional.
- **`echo`** — reflects the request: `method`, `path`, `query`, `headers`, `body`. Use
  this to assert on what a transform actually produced. A repeated query key is returned
  as an array so `key[]=a&key[]=b` can be asserted.
- **`counter`** — returns `{"hits": n}`, counting requests to that path. A `static` route
  cannot show a cache _miss_, so any fixture asserting that two steps shared one request
  needs this kind.
- **`delayMs`** — any route may delay, for timeout cases.

## Running it

```sh
just spec        # the corpus, plus schema/runtime agreement
just spec-slow   # adds the 10s timeout case, for both implementations
just test        # everything: unit tests, corpus, and the Go suite
```

The corpus is run by **both** implementations. `spec/fixtures/` is the shared
contract: the TypeScript suite in `conformance.test.ts` and the Go suite in
`packages/conduit-go/conformance_test.go` execute the same directories, so a fixture
that passes one and fails the other is a real divergence in the format.

`bun test` also picks this up, so the corpus runs in CI alongside the unit tests.

The unit tests in `../packages/conduit-ts/src/*.test.ts` are **not** superseded by this corpus. They test
internals and the CLI; the corpus tests observable conduit semantics, which is the
cross-language contract.

## Adding a case

1. Create `spec/fixtures/<descriptive-name>/` with `conduit.yaml` and either
   `expect.json` or `expect-error.txt`.
2. Name it after the **behavior** it pins, not the mechanism — `unset-env-var-becomes-literal-undefined`
   rather than `header-coercion-test-2`.
3. Add any routes the definition needs to `server.json`.
4. Run `just spec`. If a case fails, decide which is wrong: the fixture's expectation
   or the implementation. Fix whichever is the bug, and update `../docs/syntax.md` if the
   behavior was previously undocumented.

If the case concerns a _definition-level_ rule rather than runtime behavior, add it to
the agreement cases in `spec/conformance.test.ts` so the schema and the runtime parser are
held to the same answer.

## Adding a second implementation

A new implementation is conformant when `just spec` passes against it unchanged. It
needs to:

- parse the definition with the strict/non-strict key handling above,
- evaluate expressions with a JSONata 2.2.2 engine (several pure-Go ports exist, so this
  need not be written from scratch),
- serve `server.json` and reproduce the runner's loop: stand up routes, substitute
  `{{base_url}}`, execute, deep-compare.

Do not "improve" a behavior the fixtures pin. If one of them is genuinely wrong, change
it deliberately in both the fixtures and `../docs/syntax.md`, and treat that as a
breaking change to the format.
