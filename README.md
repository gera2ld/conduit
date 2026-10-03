# @gera2ld/conduit

Turn any composition of external HTTP APIs into a single async function — declaratively.

A **conduit** is a YAML/JSON definition that:

- runs a list of steps (HTTP requests) in dependency order, parallelizing independent steps
- builds each request's URL, headers, query params and body with [JSONata](https://jsonata.org) expressions evaluated against a shared context
- exposes previous responses to later steps (`steps.<id>`)
- optionally validates the input and each/final output against loose JSON Schemas (via [ajv](https://ajv.js.org))

## Try it without installing

The published package ships the `conduit` CLI, so you can run a definition straight
from the registry. This one fetches a user and the titles of their posts from
JSONPlaceholder:

```sh
npx @gera2ld/conduit run https://raw.githubusercontent.com/gera2ld/conduit/main/packages/conduit-ts/examples/user-posts.yaml -i '{"user_id": 1}'
```

```json
{
  "user": "Leanne Graham",
  "email": "Sincere@april.biz",
  "post_titles": [
    "sunt aut facere repellat provident occaecati excepturi optio reprehenderit",
    "qui est esse",
    "ea molestias quasi exercitationem repellat qui ipsa sit aut"
  ]
}
```

Nothing is installed: the definition is fetched over HTTP, and only the JSON result
lands on stdout.

## Install

```sh
npm i @gera2ld/conduit
```

## Quick start

A definition is a YAML or JSON document. This one fetches a user, then that user's
posts:

```yaml
name: user_posts
description: Fetch a user and the titles of their posts.

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

```sh
conduit run user-posts.yaml -i '{"user_id": 1, "limit": 3}'
```

Each step's `url`, `headers`, `query_transform` and `body_transform` are
[JSONata](https://jsonata.org) expressions evaluated against a shared
`{ input, steps, env }` context, where `steps` holds the responses of earlier steps.
Steps run in dependency order, so `needs` both orders a step and exposes another
step's response to it.

**[→ Full syntax reference](docs/syntax.md)** — every field, the execution model,
expression recipes, caching and validation rules, and a pitfalls checklist.

A [conformance corpus](spec/README.md) pins the behaviors this doc cannot fully express,
and a published [JSON Schema](spec/schema/conduit.schema.json) validates definitions in
editors.

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

### GET caching

A `GET` step with a positive `cache_ttl` reuses its response instead of re-fetching. Pass
a `Map` to share entries across runs:

```ts
import { executeConduit, type ConduitCache } from "@gera2ld/conduit";

// Share entries across runs with a caller-owned Map (entries are
// `{ expires: <epoch-ms>, data }`; `.clear()` to invalidate all).
const cache: ConduitCache = new Map();
await executeConduit(def, input, { cache });
await executeConduit(def, input, { cache }); // fresh entries served without HTTP
```

Without a `cache` option each execution uses a throwaway `Map`, so caching still dedups
identical `GET`s within a single run. See
[the caching rules](docs/syntax.md#caching) — including why you should not cache a URL
whose response varies by credentials.

### Headers

A step sends only the headers its own `headers` declare — nothing is added for you.
Pass `headers` to send the same headers with every request in a run:

```ts
await executeConduit(def, input, { headers: { "Accept-Language": "fr-FR" } });
```

They are defaults, not overrides: a step's own `headers` win. See
[HTTP behavior](docs/syntax.md#http-behavior).

See [`examples/user-posts.yaml`](./packages/conduit-ts/examples/user-posts.yaml) for a complete two-step conduit.

## CLI

The package ships a `conduit` bin that runs under Node (18+) and Bun:

```sh
conduit run <path | url | -> [-i <json> | -f <file> | -f -]
conduit validate <path | url | -> # parse + Zod-validate without executing
```

The conduit definition can come from a local path, an `http(s)://` URL (YAML or JSON),
or stdin via `-` — or by piping with the argument omitted:

```sh
conduit run packages/conduit-ts/examples/user-posts.yaml -i '{"user_id":1}'
conduit run https://example.com/conduit.yaml -i '{"user_id":1}'
cat my-conduit.yaml | conduit run - -i '{"user_id":1}'
echo '{"user_id":1}' | conduit run -f - my-conduit.yaml
```

> **Caution** a remote definition dictates arbitrary HTTP requests on execution —
> treat conduit URLs like code and prefer pinned revisions.

Input precedence: `-i` > `--input-file` > piped stdin > `{}`. When the conduit itself
is read from stdin, that stream is consumed — pass input via `-i` or `--input-file <path>`
(`-f -` is rejected in that case). Progress logs go to stderr; only the JSON result goes
to stdout. Exit codes: `0` ok, `1` usage/parse/validation errors, `2` execution errors.

## License

MIT
