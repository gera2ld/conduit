/**
 * Conformance harness.
 *
 * Loads language-neutral fixtures from spec/fixtures, serves their declared
 * routes, runs the conduit, and compares against the expected result. A second
 * implementation (Go) must be able to reproduce these results exactly — that is
 * what makes the corpus the arbiter of behavior rather than the docs.
 *
 * The runner is deliberately dependency-light so its logic ports cleanly: read
 * JSON, stand up routes, substitute a placeholder, run, deep-compare.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { executeConduit } from "../src/execute";
import { parseConduit, type Conduit } from "../src/types";
import type { ConduitCache } from "../src/execute";

export const FIXTURES_DIR = new URL("./fixtures/", import.meta.url).pathname;
export const SCHEMA_PATH = new URL("./schema/conduit.schema.json", import.meta.url).pathname;

/** Placeholder substituted with the live server origin before parsing. */
export const BASE_URL_TOKEN = "{{base_url}}";

export interface Route {
  path: string;
  kind?: "static" | "echo" | "counter";
  status?: number;
  contentType?: string;
  /** Body for a `static` route: an object is sent as JSON, a string verbatim. */
  body?: unknown;
  /** Artificially delay a response, for timeout cases. */
  delayMs?: number;
}

export interface ServerSpec {
  routes: Route[];
}

export interface Fixture {
  /** Directory name; also the fixture's identity. */
  name: string;
  dir: string;
  /** Conduit definition source, with BASE_URL_TOKEN still in place. */
  source: string;
  input: unknown;
  server: ServerSpec;
  /** Exactly one of these is set. */
  expect?: unknown;
  expectError?: string;
  /** Excluded from the default run (e.g. the 10s timeout case). */
  slow?: boolean;
  /** The definition is intentionally malformed; skip it in schema checks. */
  invalidDefinition?: boolean;
  /** Optional per-run env, merged over the harness defaults. */
  env?: Record<string, string | undefined>;
  /** Optional shared cache, for cases about cache behavior across runs. */
  sharedCache?: boolean;
  /** Run the whole conduit this many times in one fixture, sharing a cache. */
  runs?: number;
}

export interface RunResult {
  name: string;
  ok: boolean;
  detail: string;
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

async function readJsonIfPresent(path: string): Promise<unknown | undefined> {
  const text = await readIfPresent(path);
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`${path}: not valid JSON: ${(err as Error).message}`);
  }
}

export async function loadFixture(dir: string): Promise<Fixture> {
  const name = dir.split("/").filter(Boolean).pop()!;
  const source = await readFile(join(dir, "conduit.yaml"), "utf8");
  const input = (await readJsonIfPresent(join(dir, "input.json"))) ?? {};
  const serverFile = join(dir, "server.json");
  const serverText = await readIfPresent(serverFile);
  const server: ServerSpec = serverText ? JSON.parse(serverText) : { routes: [] };
  const expect = await readJsonIfPresent(join(dir, "expect.json"));
  const expectErrorText = (await readIfPresent(join(dir, "expect-error.txt")))?.trim();
  const slow = (await readIfPresent(join(dir, "slow"))) !== undefined;
  const env = (await readJsonIfPresent(join(dir, "env.json"))) as
    | Record<string, string>
    | undefined;

  if (expect === undefined && expectErrorText === undefined) {
    throw new Error(`${name}: needs either expect.json or expect-error.txt`);
  }
  if (expect !== undefined && expectErrorText !== undefined) {
    throw new Error(`${name}: cannot have both expect.json and expect-error.txt`);
  }

  return {
    name,
    dir,
    source,
    input,
    server,
    expect,
    expectError: expectErrorText,
    slow,
    invalidDefinition: (await readIfPresent(join(dir, "invalid-definition"))) !== undefined,
    env,
    sharedCache: (await readIfPresent(join(dir, "shared-cache"))) !== undefined,
    runs: Number((await readIfPresent(join(dir, "runs")))?.trim() ?? "1") || 1,
  };
}

export async function loadFixtures(opts: { includeSlow?: boolean } = {}): Promise<Fixture[]> {
  const entries = (await readdir(FIXTURES_DIR, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const out: Fixture[] = [];
  for (const name of entries) {
    const fixture = await loadFixture(join(FIXTURES_DIR, name));
    if (fixture.slow && !opts.includeSlow) continue;
    out.push(fixture);
  }
  return out;
}

/** Substitute the live origin into the raw definition source. */
export function materialize(source: string, baseUrl: string): Conduit {
  return parseConduit(loadYaml(source.split(BASE_URL_TOKEN).join(baseUrl)));
}

type Handler = (req: Request) => Response | Promise<Response>;

function jsonBody(value: unknown): Response {
  return Response.json(value);
}

function staticHandler(route: Route): Handler {
  return async () => {
    if (route.delayMs) await Bun.sleep(route.delayMs);
    const status = route.status ?? 200;
    const isText = typeof route.body === "string";
    if (route.body === undefined) return new Response(null, { status });
    return new Response(isText ? (route.body as string) : JSON.stringify(route.body), {
      status,
      headers: {
        "content-type": route.contentType ?? (isText ? "text/plain" : "application/json"),
      },
    });
  };
}

/**
 * Counts requests per path and returns `{ "hits": n }`. Unlike a `static` route
 * this makes a cache miss observable, which is the only way to assert that two
 * steps really shared one request.
 */
function counterHandler(): Handler {
  let hits = 0;
  return async () => {
    hits += 1;
    return jsonBody({ hits });
  };
}

function echoHandler(): Handler {
  return async (req) => {
    const url = new URL(req.url);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    let body: unknown;
    const text = await req.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return jsonBody({
      method: req.method,
      path: url.pathname,
      // Object.fromEntries keeps only the last value per key; array params
      // (`tag[]=a&tag[]=b`) are joined so the corpus can assert on them.
      query: Object.fromEntries(
        [...url.searchParams.entries()].map(([k, v]) => {
          const existing = url.searchParams.getAll(k);
          return [k, existing.length > 1 ? existing : v];
        }),
      ),
      headers,
      body: body ?? null,
    });
  };
}

export interface RunningServer {
  baseUrl: string;
  stop: () => void;
}

export function serve(spec: ServerSpec): RunningServer {
  const handlers = new Map<string, Handler>();
  for (const route of spec.routes) {
    const kind = route.kind ?? "static";
    handlers.set(
      route.path,
      kind === "echo"
        ? echoHandler()
        : kind === "counter"
          ? counterHandler()
          : staticHandler(route),
    );
  }
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const handler = handlers.get(path);
      if (!handler) return new Response("no route", { status: 404 });
      return handler(req);
    },
  });
  return { baseUrl: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

/** Stable stringify so key order never decides a comparison. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

export async function runFixture(fixture: Fixture): Promise<RunResult> {
  const server = serve(fixture.server);
  try {
    let def: Conduit;
    try {
      def = materialize(fixture.source, server.baseUrl);
    } catch (err) {
      // A fixture may assert that the definition itself is rejected.
      if (
        fixture.expectError !== undefined &&
        (err as Error).message.includes(fixture.expectError)
      ) {
        return { name: fixture.name, ok: true, detail: "parse rejected as expected" };
      }
      throw new Error(`parse failed: ${(err as Error).message}`);
    }

    const cache: ConduitCache | undefined = fixture.sharedCache ? new Map() : undefined;
    const opts = { env: fixture.env, ...(cache ? { cache } : {}) };

    let last: unknown;
    try {
      for (let i = 0; i < fixture.runs; i++) {
        last = await executeConduit(def, fixture.input, opts);
      }
    } catch (err) {
      const message = (err as Error).message;
      if (fixture.expectError !== undefined) {
        const ok = message.includes(fixture.expectError);
        return {
          name: fixture.name,
          ok,
          detail: ok
            ? "error matched"
            : `expected error containing "${fixture.expectError}", got "${message}"`,
        };
      }
      return { name: fixture.name, ok: false, detail: `unexpected error: ${message}` };
    }

    if (fixture.expectError !== undefined) {
      return {
        name: fixture.name,
        ok: false,
        detail: `expected error containing "${fixture.expectError}", but the run succeeded`,
      };
    }
    const ok = deepEqual(last, fixture.expect);
    return {
      name: fixture.name,
      ok,
      detail: ok ? "matched" : `expected ${canonical(fixture.expect)}, got ${canonical(last)}`,
    };
  } finally {
    server.stop();
  }
}
