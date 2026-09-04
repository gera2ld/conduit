import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { compileConduit } from "./compile";
import { buildWaves, executeConduit, type ConduitCache } from "./execute";
import { conduitSchema, parseConduit, type Conduit } from "./types";
import { load as loadYaml } from "js-yaml";

let baseUrl = "";
let server: ReturnType<typeof Bun.serve>;
let countedHits = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      switch (url.pathname) {
        case "/user": {
          const uid = url.searchParams.get("uid");
          if (!uid) return Response.json({ error: "uid required" }, { status: 400 });
          return Response.json({ user: { id: uid, name: "Gerald" } });
        }
        case "/orders": {
          const body = await request.json();
          if (!body.user_id) return Response.json({ error: "user_id required" }, { status: 400 });
          return Response.json({
            operator: body.operator,
            orders: [
              { id: "o1", price: 250 },
              { id: "o2", price: 50 },
              { id: "o3", price: 120 },
            ],
          });
        }
        case "/secure": {
          if (request.headers.get("authorization") !== `Bearer ${process.env.CONDUIT_TEST_TOKEN}`) {
            return Response.json({ error: "unauthorized" }, { status: 401 });
          }
          return Response.json({ ok: true });
        }
        case "/params": {
          return Response.json({ query: Object.fromEntries(url.searchParams) });
        }
        case "/counted": {
          countedHits += 1;
          if (url.searchParams.get("v") === "boom") {
            return Response.json({ error: "boom" }, { status: 500 });
          }
          return Response.json({ hits: countedHits, v: url.searchParams.get("v") ?? "" });
        }
        case "/echo": {
          return Response.json(await request.json());
        }
        case "/text": {
          return new Response("plain text", { headers: { "content-type": "text/plain" } });
        }
        case "/notfound": {
          return Response.json({ error: "missing" }, { status: 404 });
        }
        default:
          return Response.json({ error: "no route" }, { status: 404 });
      }
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  countedHits = 0;
});

const userOrdersDef = (): Conduit =>
  conduitSchema.parse({
    name: "user_orders",
    steps: [
      {
        id: "step1",
        url: `"${baseUrl}/user"`,
        query_transform: '{ "uid": input.user_query_id }',
      },
      {
        id: "step2",
        needs: ["step1"],
        method: "POST",
        url: `"${baseUrl}/orders"`,
        body_transform: '{ "user_id": steps.step1.user.id, "operator": steps.step1.user.name }',
      },
    ],
    output_transform: `{
      "user_name": steps.step1.user.name,
      "high_value_orders": steps.step2.orders[price > 100].id
    }`,
  });

describe("executeConduit", () => {
  test("chains steps with JSONata extraction and filtering", async () => {
    const output = await executeConduit(userOrdersDef(), { user_query_id: "u1" });
    expect(output).toEqual({
      user_name: "Gerald",
      high_value_orders: ["o1", "o3"],
    });
  });

  test("exposes env to transforms", async () => {
    const def = conduitSchema.parse({
      name: "secure",
      steps: [
        {
          id: "call",
          url: `"${baseUrl}/secure"`,
          headers: { authorization: '"Bearer " & env.CONDUIT_TEST_TOKEN' },
        },
      ],
      output_transform: "steps.call.ok",
    });
    const token = "tok123";
    process.env.CONDUIT_TEST_TOKEN = token;
    const output = await executeConduit(def, {}, {});
    expect(output).toBe(true);

    const outputOverride = await executeConduit(def, {}, { env: { CONDUIT_TEST_TOKEN: token } });
    expect(outputOverride).toBe(true);
  });

  test("query_transform builds the query string", async () => {
    const def = conduitSchema.parse({
      name: "params",
      steps: [
        {
          id: "p",
          url: `"${baseUrl}/params"`,
          query_transform: '{ "a": input.a, "b": "static", "c": 42 }',
        },
      ],
      output_transform: "steps.p.query",
    });
    const output = (await executeConduit(def, { a: "x" })) as Record<string, string>;
    expect(output).toEqual({ a: "x", b: "static", c: "42" });
  });

  test("validates input against input_schema", async () => {
    const def = conduitSchema.parse({
      name: "typed",
      input_schema: {
        type: "object",
        required: ["city"],
        properties: { city: { type: "string" } },
      },
      steps: [{ id: "s", url: `"${baseUrl}/text"` }],
      output_transform: "steps.s",
    });
    await expect(executeConduit(def, {})).rejects.toThrow('Conduit "typed" input');
    await expect(executeConduit(def, { city: 42 })).rejects.toThrow('Conduit "typed" input');
    await expect(executeConduit(def, { city: "SF" })).resolves.toBe("plain text");
  });

  test("throws when step output fails its output_schema", async () => {
    const def = conduitSchema.parse({
      name: "strict_step",
      steps: [
        {
          id: "s",
          url: `"${baseUrl}/text"`,
          output_schema: { type: "object" },
        },
      ],
      output_transform: "steps.s",
    });
    await expect(executeConduit(def, {})).rejects.toThrow(
      'Step "s" output validation failed: data must be object',
    );
  });

  test("passes when step output matches its output_schema", async () => {
    const def = conduitSchema.parse({
      name: "typed_step",
      steps: [
        {
          id: "s",
          url: `"${baseUrl}/user"`,
          query_transform: '{ "uid": "u9" }',
          output_schema: {
            type: "object",
            required: ["user"],
          },
        },
      ],
      output_transform: "steps.s.user.name",
    });
    await expect(executeConduit(def, {})).resolves.toBe("Gerald");
  });

  test("throws when final output fails output_schema", async () => {
    const def = conduitSchema.parse({
      name: "strict_final",
      output_schema: { type: "object", required: ["missing"] },
      steps: [{ id: "s", url: `"${baseUrl}/text"` }],
      output_transform: "'text'",
    });
    await expect(executeConduit(def, {})).rejects.toThrow('Conduit "strict_final" output');
  });

  test("skips provided-but-invalid schemas instead of throwing", async () => {
    const def = conduitSchema.parse({
      name: "loose",
      output_schema: { type: "strng" },
      steps: [{ id: "s", url: `"${baseUrl}/text"`, output_schema: { type: "strng" } }],
      output_transform: "steps.s",
    });
    await expect(executeConduit(def, {})).resolves.toBe("plain text");
  });

  test("keeps non-JSON responses as text", async () => {
    const def = conduitSchema.parse({
      name: "raw",
      steps: [{ id: "s", url: `"${baseUrl}/text"` }],
      output_transform: "steps.s",
    });
    await expect(executeConduit(def, {})).resolves.toBe("plain text");
  });

  test("propagates HTTP errors with step context", async () => {
    const def = conduitSchema.parse({
      name: "broken",
      steps: [{ id: "s", url: `"${baseUrl}/notfound"` }],
      output_transform: "steps.s",
    });
    await expect(executeConduit(def, {})).rejects.toThrow('Step "s" failed (GET');
  });

  test("detects dependency cycles at execution time", async () => {
    const raw = {
      name: "cycle",
      steps: [
        { id: "a", url: `${baseUrl}/text`, needs: ["b"] },
        { id: "b", url: `${baseUrl}/text`, needs: ["a"] },
      ],
      output_transform: "null",
    };
    expect(() => parseConduit(raw)).not.toThrow();
    await expect(executeConduit(conduitSchema.parse(raw), {})).rejects.toThrow(
      "Cycle detected in conduit steps",
    );
  });

  test("runs independent steps in parallel waves", () => {
    const waves = buildWaves(
      conduitSchema.parse({
        name: "waves",
        steps: [
          { id: "a", url: "https://example.com/a" },
          { id: "b", url: "https://example.com/b" },
          { id: "c", url: "https://example.com/c", needs: ["a", "b"] },
        ],
        output_transform: "null",
      }).steps,
    );
    expect(waves.map((wave) => wave.map((s) => s.id))).toEqual([["a", "b"], ["c"]]);
  });
});

describe("GET cache", () => {
  const countedDef = (cache_ttl?: number): Conduit =>
    conduitSchema.parse({
      name: "cached",
      steps: [
        {
          id: "s",
          url: `"${baseUrl}/counted"`,
          ...(cache_ttl !== undefined ? { cache_ttl } : {}),
        },
      ],
      output_transform: "steps.s",
    });

  test("shares GET responses across runs with a caller-provided Map", async () => {
    const cache: ConduitCache = new Map();
    const first = await executeConduit(countedDef(300), {}, { cache });
    const second = await executeConduit(countedDef(300), {}, { cache });
    expect(countedHits).toBe(1);
    expect(second).toEqual(first);
    expect([...cache.keys()]).toEqual([`GET ${baseUrl}/counted`]);
    const entry = cache.get(`GET ${baseUrl}/counted`)!;
    expect(entry.data).toEqual(first);
    expect(entry.expires).toBeGreaterThan(Date.now() + 299_000);
    expect(entry.expires).toBeLessThanOrEqual(Date.now() + 300_000);
  });

  test("creates a throwaway cache when none is provided", async () => {
    await executeConduit(countedDef(300), {});
    await executeConduit(countedDef(300), {});
    expect(countedHits).toBe(2);
  });

  test("dedups identical GETs within one run", async () => {
    const def = conduitSchema.parse({
      name: "dup",
      steps: [
        { id: "a", url: `"${baseUrl}/counted"`, cache_ttl: 300 },
        { id: "b", url: `"${baseUrl}/counted"`, cache_ttl: 300 },
      ],
      output_transform: '{ "a": steps.a, "b": steps.b }',
    });
    const output = (await executeConduit(def, {})) as any;
    expect(countedHits).toBe(1);
    expect(output.b).toEqual(output.a);
  });

  test("keys on the sorted query string", async () => {
    const def = conduitSchema.parse({
      name: "queries",
      steps: [
        {
          id: "a",
          url: `"${baseUrl}/counted"`,
          query_transform: '{ "x": 1, "y": 2 }',
          cache_ttl: 300,
        },
        {
          id: "b",
          url: `"${baseUrl}/counted"`,
          query_transform: '{ "y": 2, "x": 1 }',
          cache_ttl: 300,
        },
        {
          id: "c",
          url: `"${baseUrl}/counted"`,
          query_transform: '{ "x": 1, "y": 3 }',
          cache_ttl: 300,
        },
      ],
      output_transform: "steps.a",
    });
    await executeConduit(def, {}, { cache: new Map() });
    expect(countedHits).toBe(2);
  });

  test("treats cache_ttl: 0 as no cache", async () => {
    const cache: ConduitCache = new Map();
    await executeConduit(countedDef(0), {}, { cache });
    await executeConduit(countedDef(0), {}, { cache });
    expect(countedHits).toBe(2);
    expect(cache.size).toBe(0);
  });

  test("ignores cache_ttl for non-GET steps", async () => {
    const def = conduitSchema.parse({
      name: "post",
      steps: [
        {
          id: "s",
          method: "POST",
          url: `"${baseUrl}/echo"`,
          body_transform: '{ "n": 1 }',
          cache_ttl: 300,
        },
      ],
      output_transform: "steps.s",
    });
    const cache: ConduitCache = new Map();
    const output = await executeConduit(def, {}, { cache });
    expect(output).toEqual({ n: 1 });
    expect(cache.size).toBe(0);
  });

  test("refetches expired entries and serves fresh pre-seeded ones", async () => {
    const cache: ConduitCache = new Map([
      [`GET ${baseUrl}/counted`, { expires: Date.now() - 1000, data: "stale" }],
    ]);
    const output = await executeConduit(countedDef(300), {}, { cache });
    expect(countedHits).toBe(1);
    expect(output).not.toBe("stale");
    expect(cache.get(`GET ${baseUrl}/counted`)!.expires).toBeGreaterThan(Date.now());

    countedHits = 0;
    const seeded: ConduitCache = new Map([
      [`GET ${baseUrl}/counted`, { expires: Date.now() + 60_000, data: { seeded: true } }],
    ]);
    await expect(executeConduit(countedDef(300), {}, { cache: seeded })).resolves.toEqual({
      seeded: true,
    });
    expect(countedHits).toBe(0);
  });

  test("does not cache failures", async () => {
    const def = conduitSchema.parse({
      name: "fails",
      steps: [
        {
          id: "s",
          url: `"${baseUrl}/counted"`,
          query_transform: '{ "v": "boom" }',
          cache_ttl: 300,
        },
      ],
      output_transform: "steps.s",
    });
    const cache: ConduitCache = new Map();
    await expect(executeConduit(def, {}, { cache })).rejects.toThrow('Step "s" failed');
    await expect(executeConduit(def, {}, { cache })).rejects.toThrow('Step "s" failed');
    expect(countedHits).toBe(2);
    expect(cache.size).toBe(0);
  });

  test("rejects invalid cache_ttl values", () => {
    const bad = (cache_ttl: unknown) =>
      parseConduit({
        name: "bad",
        steps: [{ id: "s", url: "https://example.com", cache_ttl }],
        output_transform: "1",
      });
    expect(() => bad(-5)).toThrow();
    expect(() => bad("300")).toThrow();
    expect(() =>
      parseConduit({
        name: "ok",
        steps: [{ id: "s", url: "https://example.com", cache_ttl: 0 }],
        output_transform: "1",
      }),
    ).not.toThrow();
  });
});

describe("parseConduit", () => {
  test("rejects unknown top-level keys", () => {
    expect(() =>
      parseConduit({ name: "x", steps: [], output_transform: "1", typo_key: true }),
    ).toThrow();
  });

  test("rejects duplicate step ids", () => {
    expect(() =>
      parseConduit({
        name: "dup",
        steps: [
          { id: "a", url: "https://example.com" },
          { id: "a", url: "https://example.com" },
        ],
        output_transform: "1",
      }),
    ).toThrow("Duplicate step id");
  });

  test("rejects references to unknown steps in needs", () => {
    expect(() =>
      parseConduit({
        name: "ghost",
        steps: [{ id: "a", url: "https://example.com", needs: ["nope"] }],
        output_transform: "1",
      }),
    ).toThrow("needs unknown step");
  });

  test("allows forward references to later steps", () => {
    expect(() =>
      parseConduit({
        name: "forward",
        steps: [
          { id: "a", url: "https://example.com", needs: ["b"] },
          { id: "b", url: "https://example.com" },
        ],
        output_transform: "1",
      }),
    ).not.toThrow();
  });

  test("defaults method to GET", () => {
    const def = parseConduit({
      name: "m",
      steps: [{ id: "a", url: "https://example.com" }],
      output_transform: "1",
    });
    expect(def.steps[0].method).toBe("GET");
  });
});

describe("user_posts example", () => {
  test("runs against the live JSONPlaceholder API", async () => {
    const raw = await Bun.file(new URL("../examples/user-posts.yaml", import.meta.url)).text();
    const def = parseConduit(loadYaml(raw));
    expect(def.name).toBe("user_posts");
    const output = (await executeConduit(def, { user_id: 1 })) as any;
    expect(output.user).toBe("Leanne Graham");
    expect(output.email).toContain("@");
    expect(output.post_titles).toEqual(expect.arrayContaining([expect.any(String)]));
  });
});

describe("compileConduit", () => {
  test("compiles to a plain async function", async () => {
    const fn = compileConduit(userOrdersDef());
    expect(typeof fn).toBe("function");
    const output = await fn({ user_query_id: "u1" });
    expect(output).toEqual({
      user_name: "Gerald",
      high_value_orders: ["o1", "o3"],
    });
  });

  test("compiled function accepts per-call env", async () => {
    const def = conduitSchema.parse({
      name: "secure",
      steps: [
        {
          id: "call",
          url: `"${baseUrl}/secure"`,
          headers: { authorization: '"Bearer " & env.CONDUIT_TEST_TOKEN' },
        },
      ],
      output_transform: "steps.call.ok",
    });
    process.env.CONDUIT_TEST_TOKEN = "tok123";
    const fn = compileConduit(def);
    await expect(fn({}, { env: { CONDUIT_TEST_TOKEN: "tok123" } })).resolves.toBe(true);
    await expect(fn({}, { env: {} })).rejects.toThrow('Step "call" failed');
  });
});
