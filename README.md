# @gera2ld/conduit

Turn any composition of external HTTP APIs into a single async function — declaratively.

A **conduit** is a YAML/JSON definition that:

- runs a list of steps (HTTP requests) in dependency order, parallelizing independent steps
- builds each request's URL, headers, query params and body with [JSONata](https://jsonata.org) expressions evaluated against a shared context
- exposes previous responses to later steps (`steps.<id>`)
- optionally validates the input and each/final output against loose JSON Schemas (via [ajv](https://ajv.js.org))

## Install

```sh
npm i @gera2ld/conduit
```

## Definition

```yaml
name: user_orders
description: Fetch a user and their high-value orders.
input_schema: # optional JSON Schema for the tool/API input
  type: object
  required: [user_query_id]
output_schema: # optional JSON Schema for the final output
  type: object
steps:
  - id: step1
    url: '"https://api.example.com/get_user"'
    method: GET
    query_transform: '{ "uid": input.user_query_id }'

  - id: step2
    needs: [step1]
    method: POST
    url: '"https://api.example.com/get_orders"'
    body_transform: |
      {
        "user_id": steps.step1.user.id,
        "operator": steps.step1.user.name
      }

output_transform: |
  {
    "user_name": steps.step1.user.name,
    "high_value_orders": steps.step2.orders[price > 100].id
  }
```

The JSONata context is `{ input, steps: { <stepId>: <parsedResponse> }, env }`.
`env` is `process.env` by default, or whatever you pass per call.

> **Note** JSONata treats unquoted object keys as _expressions_, not literals. Quote your
> literal keys: `{ "uid": input.x }` works; `{ uid: input.x }` evaluates `uid` as a field
> reference (usually `undefined`) and silently drops the pair.

## Usage

The package deals in plain objects — parse YAML/JSON yourself with any library
(e.g. js-yaml), validate with `parseConduit`, then compile to a function:

```ts
import { compileConduit, parseConduit } from "@gera2ld/conduit";
import { load as loadYaml } from "js-yaml";

const def = parseConduit(loadYaml(yamlText));

// A plain async function — bind it to anything (AI SDK tool, HTTP route, queue worker).
const run = compileConduit(def);
const output = await run({ user_query_id: "u1" }, { env: process.env });
```

### Validation semantics

`input_schema`, per-step `output_schema` and top-level `output_schema` are validated with ajv
when provided. An absent schema means no validation; a provided-but-invalid schema is skipped
with a warning rather than throwing.

### Step options

| Field             | Required | Description                                                       |
| ----------------- | -------- | ----------------------------------------------------------------- |
| `id`              | yes      | Unique step id; responses land on `steps.<id>`                    |
| `url`             | yes      | JSONata expression evaluating to the request URL                  |
| `method`          | no       | `GET` (default), `POST`, `PUT`, `PATCH`, `DELETE`                 |
| `headers`         | no       | Map of header name → JSONata expression                           |
| `query_transform` | no       | JSONata expression evaluating to the query param object           |
| `body_transform`  | no       | JSONata expression evaluating to the request body (non-GET)       |
| `needs`           | no       | Step ids this step depends on (enables ordering + parallel waves) |
| `cache_ttl`       | no       | GET-only response cache TTL in seconds (`0`/omitted = off)        |
| `output_schema`   | no       | JSON Schema validating this step's parsed response                |

### GET caching

Steps with `cache_ttl` (a positive number of seconds) reuse `GET` responses instead of
re-fetching. The key is `GET <url>` with the query string sorted by key; headers are
**not** part of the key, so don't cache URLs whose responses vary by credentials.
Expired entries are refetched on next access; failures and validation errors are never
cached; non-`GET` steps ignore the field.

```ts
import { executeConduit, type ConduitCache } from "@gera2ld/conduit";

// Share entries across runs with a caller-owned Map (entries are
// `{ expires: <epoch-ms>, data }`; `.clear()` to invalidate all).
const cache: ConduitCache = new Map();
await executeConduit(def, input, { cache });
await executeConduit(def, input, { cache }); // fresh entries served without HTTP
```

Without a `cache` option each execution uses a throwaway `Map`, so caching still dedups
identical `GET`s within a single run (including parallel steps in the same wave).

See [`examples/user-posts.yaml`](./examples/user-posts.yaml) for a complete two-step conduit.

## License

MIT
