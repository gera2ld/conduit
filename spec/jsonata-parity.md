# JSONata engine parity

Conduit's expressions are [JSONata](https://jsonata.org). A second implementation
(Go) does not need its own expression engine — but only if it picks one that behaves
like `jsonata-js`. They are **not** interchangeable, and the two most popular Go
ports are not compatible despite advertising full parity.

## The decision

**`github.com/recolabs/gnata`** — the only engine measured at full parity on the
constructs this format depends on.

| Engine                                  | Parity | Divergence from `jsonata-js`                                                                            |
| --------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------- |
| **`github.com/recolabs/gnata`**         | 17/17  | none                                                                                                    |
| `github.com/darius-lesch/jsonata-go/v2` | 9/13   | **errors** on an undefined path; `null ?? x` wrongly yields `x`                                         |
| `github.com/tiaanduplessis/jsonata-go`  | 9/13   | errors on undefined paths; an unquoted object key becomes a _literal_; a bare `{}` maps over a sequence |

Both rejected engines state full `jsonata-js` v2.2.2 parity in their READMEs, and both
fail a third of the cases here. Verify, do not trust the claim.

The differences are not cosmetic. `jsonata-js` is _lenient_: an unresolvable path
yields undefined and evaluation continues. A strict engine raises instead, which turns
a conduit that quietly drops a field into one that fails outright — or vice versa.

### Working with gnata from Go

gnata returns `*evaluator.OrderedMap` for object constructors and a null sentinel for
undefined. Both are internal: `OrderedMap` has unexported fields, so it marshals as `{}`
and `json.Marshal` silently produces wrong output. Call `gnata.NormalizeValue` at the
evaluation boundary so every consumer sees plain Go types — see
`packages/conduit-go/jsonata.go`.

## How this is enforced

`spec/jsonata-parity/cases.json` records what `jsonata-js` returns for each construct.
Two tests read it:

- `packages/conduit-go/jsonata_parity_test.go` — compiles and evaluates every case
  with gnata and requires identical output. Switching engines fails here.
- `spec/parity.test.ts` — re-verifies the recorded values against `jsonata-js`, so the
  file cannot drift into describing some other engine's behavior, and asserts the Go
  embed copy is in sync.

Regenerate after changing the case list:

```sh
just parity   # records results from jsonata-js, then syncs the Go copy
```

The recorded values are always produced by `jsonata-js` (`spec/gen-parity-cases.ts`),
never hand-written — a hand-written expectation is just a second place to be wrong.

## Known risk: regex

**A regex pattern must be a literal.** `$replace(s, "[0-9]", "N")` does not do what it
looks like: JSONata treats a quoted string as a literal string, so that call returns
`s` unchanged. Use a regex literal:

```jsonata
$replace(s, "[0-9]", "N")     // no substitution — "[0-9]" is matched literally
$replace(s, /[0-9]/, "N")     // substitutes
```

Both implementations agree on this, so it is pinned by the
`regex-pattern-must-be-a-literal` fixture. `$match` additionally **throws** on a string
pattern in `jsonata-js`; the literal form works in both.

**Two real divergences remain.** These cannot be made conformant without changing an
engine, so they are documented rather than gated:

| Expression                     | `jsonata-js`             | `gnata`                       |
| ------------------------------ | ------------------------ | ----------------------------- |
| `$match("abc", /b/)`           | `{match, index, groups}` | `{match, start, end, groups}` |
| `$match("abc", /b/).index`     | `1`                      | `null`                        |
| `$match("abc", /b/).start`     | _undefined_              | `1`                           |
| `$match("abc", /[0-9]+(?=d)/)` | _undefined_ (no match)   | **error**: RE2 rejects `(?=`  |

Two consequences for a definition that must run under both:

- **Do not read `$match` position fields.** `.index` is null under Go; `.start` is
  undefined under TypeScript. Neither name is portable.
- **Avoid lookahead, lookbehind and backreferences.** `jsonata-js` inherits JavaScript's
  `RegExp`; gnata uses Go's `regexp` (RE2), which is linear-time but rejects them. A
  definition relying on lookahead silently finds no match under TypeScript and **fails
  the step** under Go — the worst combination, since it is quiet on one side and loud on
  the other.

`$replace`, `$contains` and `$split` with literal patterns are portable and covered by
the corpus.

## What is covered

Each case maps to a conduit fixture in `spec/fixtures/`:

| Construct                                     | Fixture                                |
| --------------------------------------------- | -------------------------------------- |
| Unquoted object key drops the pair            | `unquoted-key-drops-pair`              |
| Projection collapses to a scalar on one match | `projection-collapses-to-scalar`       |
| Trailing `[]` forces an array                 | `trailing-bracket-forces-array`        |
| A bare `{}` does not map over a sequence      | `bare-object-constructor-does-not-map` |
| `$map` with a bound variable                  | `map-with-bound-variable`              |
| `??` on a missing key, but not on `null`      | `optional-input-default`               |
| Undefined path access is silent               | `hyphenated-key-needs-lookup`          |
| Hyphenated keys need `$lookup()`              | `hyphenated-key-needs-lookup`          |
| String concatenation and `$string()` coercion | quick start in `docs/syntax.md`        |
