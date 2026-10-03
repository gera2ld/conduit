# Conduit definition syntax

A **conduit** is a YAML or JSON document that turns a sequence of HTTP calls into a
single function. This is the complete reference for writing one: every field, how
execution is ordered, how expressions are evaluated, and the failure modes worth
knowing about before you ship.

For a two-step definition to start from, jump to [Quick start](#quick-start). For a
field-by-field lookup, see [Top-level fields](#top-level-fields) and
[Step fields](#step-fields).

This document is the prose reference. The normative artifacts are the published
[JSON Schema](../spec/schema/conduit.schema.json) for shape, and the
[conformance corpus](../spec/README.md) for behavior — where a fixture and this prose
disagree, the fixture is right and this document has a bug in it.

---

## Quick start

This definition fetches a user, then that user's posts. Saved as `user-posts.yaml`, it
runs as written against [JSONPlaceholder](https://jsonplaceholder.typicode.com):

```sh
conduit run user-posts.yaml -i '{"user_id": 1, "limit": 3}'
```

```yaml
name: user_posts
description: Fetch a user and the titles of their posts.

input_schema:
  type: object
  required: [user_id]

steps:
  - id: user
    url: '"https://jsonplaceholder.typicode.com/users/" & $string(input.user_id)'
    output_schema:
      type: object
      required: [id, name]

  - id: posts
    needs: [user]
    url: '"https://jsonplaceholder.typicode.com/posts"'
    query_transform: '{ "userId": steps.user.id, "_limit": $number(input.limit ?? 3) }'
    output_schema:
      type: array

output_transform: |
  {
    "user_name": steps.user.name,
    "post_ids": steps.posts.id[],
    "post_titles": steps.posts.title[]
  }
```

The shape to notice: each step names an `id`, requests a `url`, and — when it depends on
an earlier step — lists that step in `needs`. The final `output_transform` assembles
whatever shape the caller needs from the responses collected in `steps`.

---

## Execution model

A run proceeds in a fixed order:

1. The input is validated against `input_schema`, if present.
2. Steps are grouped into **waves** by their `needs` dependencies.
3. Each wave runs its steps **concurrently**; the next wave starts once the current one
   finishes.
4. Each response is validated against that step's `output_schema`, if present.
5. `output_transform` runs against the fully populated context.
6. The result is validated against the top-level `output_schema`, if present.

### The context object

Every expression in a definition — `url`, `headers`, `query_transform`,
`body_transform`, and `output_transform` — is a [JSONata](https://jsonata.org) expression
evaluated against the same context object:

| Binding | Value                                                         |
| ------- | ------------------------------------------------------------- |
| `input` | The caller's input, exactly as supplied                       |
| `steps` | `{ <stepId>: <parsed response> }` for every step already done |
| `env`   | Environment variables; `process.env` by default               |

`steps` grows as the run proceeds. A step in wave _N_ sees every step from waves before
it and nothing from its own wave.

> **`needs` is not just ordering.** Steps in the same wave run at the same time and
> cannot see each other's results. If a step reads `steps.other`, it must list `other`
> in `needs` — otherwise it reads `undefined` and the failure is silent.

### Ordering and cycles

`needs` may reference a step defined **later** in the file; the writer sorts
topologically regardless of declaration order. A dependency cycle is not caught when the
definition is parsed — it surfaces as `Cycle detected in conduit steps` at run time.

There is no dynamic fan-out. The step list is fixed when the definition is written, so
per-item requests must be unrolled into individual steps or pushed into a single
endpoint that accepts a batch.

---

## Top-level fields

| Field              | Required | Type        | Description                                         |
| ------------------ | -------- | ----------- | --------------------------------------------------- |
| `name`             | yes      | string      | Non-empty identifier, used in error messages        |
| `steps`            | yes      | array       | At least one step (see [Step fields](#step-fields)) |
| `output_transform` | yes      | string      | JSONata expression producing the final output       |
| `description`      | no       | string      | Human-readable summary                              |
| `input_schema`     | no       | JSON Schema | Validates the input before any step runs            |
| `output_schema`    | no       | JSON Schema | Validates the result of `output_transform`          |
| `$schema`          | no       | string      | Accepted for editor tooling; not used at runtime    |

Unknown top-level keys are a **parse error**, so a typo like `inputschema` fails loudly
at load time.

---

## Step fields

| Field             | Required | Type             | Description                                                     |
| ----------------- | -------- | ---------------- | --------------------------------------------------------------- |
| `id`              | yes      | string           | Unique, non-empty; the key this response is filed under         |
| `url`             | yes      | string           | JSONata expression evaluating to an absolute request URL        |
| `method`          | no       | enum             | `GET` (default), `POST`, `PUT`, `PATCH`, `DELETE`               |
| `headers`         | no       | map of strings   | Header name → JSONata expression (value is coerced to a string) |
| `query_transform` | no       | string           | JSONata expression evaluating to the query parameter object     |
| `body_transform`  | no       | string           | JSONata expression evaluating to the request body (non-`GET`)   |
| `needs`           | no       | array of strings | Step ids this one depends on                                    |
| `cache_ttl`       | no       | number ≥ 0       | `GET`-only response cache lifetime in seconds; `0` disables     |
| `output_schema`   | no       | JSON Schema      | Validates this step's parsed response                           |

Two rules about the step object are worth stating explicitly, because they fail
differently from the top level:

- **Duplicate `id`s are a parse error**, as is a `needs` entry pointing at a step that
  does not exist. Both are reported before the run starts.
- **Unknown keys on a step are silently dropped.** Unlike the top level, a typo inside a
  step is not caught — `cacheTTL: 300` or `body_trasform` is accepted and then ignored,
  so the step quietly runs without the behavior you intended. Check spelling.

---

## Expressions

### Writing them in YAML

A JSONata expression is just a string. Single-quote it in YAML so the inner double
quotes survive:

```yaml
url: '"https://api.example.com/users"' # string literal
url: '"/users/" & input.user_id' # concatenation
```

Multi-line expressions read better as YAML literal blocks (`|`), which preserve
indentation and newlines:

```yaml
output_transform: |
  {
    "user_name": steps.user.name,
    "orders": steps.orders.orders.id
  }
```

### Object keys must be quoted

JSONata treats an unquoted key in an object constructor as a **field reference**, not a
literal name. An unresolvable reference makes the whole pair vanish:

```jsonata
{ uid: input.x }       // evaluates to {} — the pair is dropped
{ "uid": input.x }     // { "uid": ... }
```

Quote every key you write. The same applies to output objects, so an unquoted key in
`output_transform` produces an object that is missing that field rather than an error.

### Filtering and reshaping

`[]` filters a sequence, and `.field` projects a field out of every element:

```jsonata
steps.orders.orders[price > 100]        // the orders over 100
steps.orders.orders[price > 100].id     // their ids
```

To build a **new** object per element, map over a bound variable with `$map`. Bind each
element to `$o` and reference its fields through it:

```jsonata
$map(steps.orders.orders, function($o) { { "id": $o.id, "total": $o.price * $o.qty } })
```

Two traps here, both of which fail quietly rather than raising an error:

- **A bare `{ ... }` does not map.** `steps.orders.orders{ "id": id }` evaluates to a
  single object with array values — `{"id": ["o1","o2","o3"]}` — not the list of objects
  you expected. A leading `.` (`steps.orders.orders.{ "id": id }`) maps correctly, and so
  does `$map`.
- **Fields must be read from the bound variable.** Inside a `{}` constructor, a bare
  `price * qty` resolves against the whole context rather than the current element, so
  it throws `The left side of the "*" operator must evaluate to a number`. Write
  `$o.price * $o.qty`.

### Keep results a consistent shape

A projection collapses to a scalar when exactly one element matches, and to an array when
several do. The same expression therefore returns `"o1"` against one match and
`["o1", "o3"]` against two — a difference that breaks callers expecting a list.

Append `[]` to force an array, whatever the match count:

```jsonata
steps.orders.orders[price > 100].id     // "o1" or ["o1","o3"] — avoid
steps.orders.orders[price > 100].id[]   // always an array
```

### Reading input defensively

`??` supplies a fallback when the left side is missing, and `$exists()` tests for a field
that may be absent:

```jsonata
input.user_query_id
input.limit ?? 20
$exists(input.verbose) ? 1 : 0
```

Use `??` on any input field your `input_schema` does not mark as required. Without it, a
missing field propagates `undefined` into the request, often surfacing much later as an
opaque HTTP error.

### Regular expressions

A regex pattern must be a **literal**, written between slashes. A quoted string is
matched literally, so this does nothing:

```jsonata
$replace(input.title, "[0-9]+", "")   // no change — "[0-9]+" is a literal string
$replace(input.title, /[0-9]+/, "")   // strips digits
```

This is easy to miss because the string form is accepted silently rather than rejected.
`$match` is stricter: given a string pattern it fails outright with a signature error.

> **Portability** `$match` reports the match position as `index` in the TypeScript
> implementation and as `start`/`end` in Go, so neither name is portable. Lookahead and
> backreferences work in neither portably. See
> [the parity notes](../spec/jsonata-parity.md#known-risk-regex).

### Reading hyphenated keys

Response and header keys are frequently hyphenated — `content-type`, `x-api-key`. Neither
dot nor bracket notation can reach them, and neither errors: they quietly yield the
enclosing object. Use `$lookup()`:

```jsonata
steps.r.headers.x-api-key              // undefined
steps.r.headers["x-api-key"]           // the whole headers object — not what you meant
$lookup(steps.r.headers, "x-api-key")  // correct
```

This bites hardest in the `echo` fixture of the [conformance corpus](../spec/README.md),
where reading a header back is the whole point of the assertion.

### Numbers in query parameters

Query values are serialized to strings. JSONata does not convert for you, so a numeric
field reaching `query_transform` as a number must be handled explicitly if the API
rejects it:

```jsonata
{ "limit": $number(input.limit) }
```

### Secrets and environment variables

Read credentials from `env` and build the header expression from them:

```yaml
headers:
  authorization: '"Bearer " & env.API_TOKEN'
```

A missing variable evaluates to `undefined`, and header values are coerced with
`String(...)` — so an unset token silently sends the literal text `undefined`. Supply a
default:

```yaml
headers:
  authorization: '"Bearer " & (env.API_TOKEN ?? "")'
```

---

## Validation

`input_schema`, each step's `output_schema`, and the top-level `output_schema` are
[JSON Schema](https://json-schema.org) documents checked with
[ajv](https://ajv.js.org). All three are optional; omitting one skips that check.

Validation is deliberately lenient, so a malformed schema never takes a working
definition down:

- A schema that is absent, or is not an object, is ignored.
- A schema ajv cannot compile is skipped with a logged warning and no validation runs.

Failures that _do_ occur are reported with the conduit or step that produced them:

| Message                                     | Meaning                              |
| ------------------------------------------- | ------------------------------------ |
| `Conduit "<name>" input ...`                | Input failed `input_schema`          |
| `Step "<id>" output validation failed: ...` | Response failed its schema           |
| `Conduit "<name>" output ...`               | `output_transform` failed its schema |

A step's `output_schema` sees the **parsed** response body — the same value later steps
and `output_transform` receive — so a schema written against the shape you expect is
also a useful check on an upstream API's behavior.

---

## Caching

`cache_ttl` opts a step into response caching for a given number of seconds. It applies
to `GET` only; other methods ignore the field entirely, and `0` (or omitting it) means
no caching.

- The cache key is the method, URL, and query string **sorted by key**, so two steps
  requesting the same URL with the same parameters in a different order share an entry.
- **Headers are not part of the key.** A cached entry will be served to a request
  carrying different credentials, so do not set `cache_ttl` on a URL whose response varies
  by auth. A response cached under one user's token can otherwise be handed to another.
- Identical `GET`s in the same run are deduplicated, including parallel steps in one
  wave — the second caller awaits the first request instead of issuing its own.
- Failures are never cached, and an entry that has expired is refetched on next access.
- Entries live in a `Map` you own, so they can be shared across runs or discarded with
  `.clear()`. See [GET caching](../README.md#get-caching) for the programmatic API.

---

## HTTP behavior

Details of how a step turns expressions into a request, and what comes back.

**The URL must be absolute.** It is parsed with `new URL()`, so a relative path fails.
Build paths by concatenating onto a literal base. Numbers are stringified with `$string()`
rather than implicitly:

```yaml
# path segment
url: '"/users/" & input.user_id'

# full URL, numeric id
url: '"https://api.example.com/users/" & $string(input.user_id)'
```

**`query_transform` replaces any query string in `url`.** If the URL already carries
parameters and `query_transform` is also set, the URL's own query string is overwritten.
Put every parameter in one place or the other, not both.

**Array parameters repeat the key.** `{ "tag": ["a","b"] }` serializes as
`tag[]=a&tag[]=b`.

**Bodies apply to non-`GET` requests only.** `body_transform` is ignored on a `GET`. On
other methods, when it evaluates to a value the request sends it as JSON with a
`content-type: application/json` header; an expression yielding `undefined` sends no
body. A `GET` that needs parameters wants `query_transform` instead.

**Each request times out after 10 seconds.** There is no per-step timeout field.

**Nothing is sent unless it is asked for.** A step sends the headers its own `headers`
declare and no others — no `User-Agent`, no `Accept-Language`. Pass `headers` to
`executeConduit` (or `conduit.Headers` in Go) to add headers to every request in a run:

```ts
await executeConduit(def, input, { headers: { "Accept-Language": "fr-FR" } });
```

They are defaults, not overrides: a step's own `headers` still win, which is what lets
a definition send credentials the caller does not know about.

**Responses are parsed as JSON when possible, and kept as text otherwise.** A
non-JSON body reaches transforms as a string, so a step returning HTML or plain text is
usable — just not with field access.

**A non-2xx status fails the step.** The error names the step, method, and URL:

```
Step "user" failed (GET https://api.example.com/users/): Not Found
```

---

## Pitfalls

| Symptom                                                                | Cause                                                                         | Fix                                        |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------ |
| Request succeeds, output object is missing a field                     | Unquoted JSONata key in an object constructor                                 | Quote the key: `{ "id": id }`              |
| Output is a bare string instead of a list                              | Projection collapsed to a scalar on a single match                            | Append `[]`, or wrap in `[...]`            |
| Output is one object holding arrays instead of a list of objects       | `{}` without a leading `.` does not map over a sequence                       | Use `$map`, or `seq.{ ... }`               |
| Reading `content-type` yields the whole headers object                 | Hyphenated keys need `$lookup()`; dot and bracket notation both fail silently | `$lookup(obj, "content-type")`             |
| A regex substitution does nothing                                      | The pattern was quoted, so it matched literally                               | Use a literal: `/[0-9]+/`, not `"[0-9]+"`  |
| Transform throws "left side of the operator must evaluate to a number" | Bare field inside `{}` resolved against the context, not the element          | Bind the element (`$o.price * $o.qty`)     |
| Step reads `undefined` from another step                               | Both steps are in the same wave and run concurrently                          | Add the other step to `needs`              |
| A step's option has no effect                                          | Unknown key on a step is silently dropped                                     | Check the spelling against the field table |
| Query parameters are ignored                                           | `query_transform` overwrote the query string already in `url`                 | Keep all parameters in one place           |
| API receives the literal text `undefined`                              | Unset `env` variable coerced to a string in a header                          | Append `?? ""` to the expression           |
| `GET` request has no body                                              | `body_transform` is ignored on `GET`                                          | Use `query_transform`                      |
| Cached data returned to the wrong caller                               | `cache_ttl` on a URL whose response varies by auth                            | Remove `cache_ttl`, or vary the URL        |
| API rejects the request (403, 406)                                     | The step sends nothing the site wants                                         | Add headers via `ExecuteOptions.headers`   |
| Fails only under a second identical call                               | Query parameter order differs between the two steps                           | Sort keys in `query_transform`             |

---

## Templates

Starting points for common shapes. Replace the `api.example.com` hosts with real
endpoints.

### Single request

```yaml
name: current_rate
description: Fetch a single current value.
steps:
  - id: rate
    url: '"https://api.example.com/rates/current"'
    output_schema:
      type: object
      required: [value]

output_transform: '{ "rate": steps.rate.value }'
```

### Two requests, second depends on the first

```yaml
name: user_profile
steps:
  - id: user
    url: '"https://api.example.com/users"'
    query_transform: '{ "uid": input.user_query_id }'
    output_schema:
      type: object
      required: [id, name]

  - id: posts
    needs: [user]
    url: '"https://api.example.com/posts"'
    query_transform: '{ "userId": steps.user.id, "limit": $number(input.limit ?? 10) }'
    output_schema:
      type: array

output_transform: |
  {
    "name": steps.user.name,
    "post_titles": steps.posts.title[]
  }
```

### Authenticated POST

Credentials come from `env`, which defaults to `process.env`. The `??` default keeps an
unset variable from reaching the server as the text `undefined`.

```yaml
name: create_ticket
steps:
  - id: create
    method: POST
    url: '"https://api.example.com/tickets"'
    headers:
      authorization: '"Bearer " & (env.API_TOKEN ?? "")'
    body_transform: |
      {
        "title": input.title,
        "body": input.body,
        "priority": input.priority ?? "normal"
      }
    output_schema:
      type: object
      required: [id, url]

output_transform: '{ "ticket": steps.create.id, "url": steps.create.url }'
```

There is no need to set `content-type` yourself — a JSON body is serialized with
`content-type: application/json` automatically. Add a header only to override it.

### Cached GET

Only safe where the response is the same for every caller. For a URL behind
credentials, leave `cache_ttl` off — the key does not include headers.

```yaml
name: product_catalog
steps:
  - id: catalog
    url: '"https://api.example.com/catalog"'
    cache_ttl: 300
    output_schema:
      type: object
      required: [products]

output_transform: '{ "products": steps.catalog.products }'
```

---

## Before you ship

- Every `id` is unique, and every `needs` entry names a step that exists.
- Every step that reads another step's response lists it in `needs`.
- Every object key in every transform is quoted.
- Every projection that should return a list ends in `[]`.
- Optional input fields are read with `??`.
- Every step has an `output_schema` if its response shape is not guaranteed.
- `cache_ttl` appears only on `GET` steps whose response does not depend on credentials.
- `conduit validate <file>` parses and checks the definition without running it.
