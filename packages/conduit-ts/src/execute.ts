import { buildSearchParams, simpleRequest } from "@gera2ld/common";
import { evalExpr } from "./jsonata";
import type { Conduit, ConduitStep } from "./types";
import { makeValidator, type Validator } from "./validate";

/**
 * Merge the header layers into what goes on the wire, lowest precedence first: the
 * caller's headers, then the step's own.
 *
 * Names are lowercased on the way in. A header name is case-insensitive, so
 * merging `Authorization` with a caller's `authorization` as distinct keys would
 * send both — and in Go, whose map has no order, which one the server kept would
 * not be predictable.
 */
function resolveHeaders(
  run: Record<string, string> | undefined,
  step: Record<string, string>,
): Record<string, string> {
  const resolved = new Map<string, string>();
  for (const layer of [run, step]) {
    for (const [name, value] of Object.entries(layer ?? {})) {
      resolved.set(name.toLowerCase(), value);
    }
  }
  return Object.fromEntries(resolved);
}

export interface ConduitContext {
  input: unknown;
  steps: Record<string, unknown>;
  env: Record<string, string | undefined>;
}

export interface CacheEntry {
  /** Epoch millis after which the entry is stale. */
  expires: number;
  data: unknown;
}

export type ConduitCache = Map<string, CacheEntry>;

export interface ExecuteOptions {
  env?: Record<string, string | undefined>;
  /** Shared GET response cache. A throwaway Map is used when omitted. */
  cache?: ConduitCache;
  /** Sent on every request. A step's own `headers` win over these. */
  headers?: Record<string, string>;
}

export function topoSort(steps: readonly ConduitStep[]): ConduitStep[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const state = new Map<string, "visiting" | "done">();
  const order: ConduitStep[] = [];
  const visit = (step: ConduitStep) => {
    const status = state.get(step.id);
    if (status === "done") return;
    if (status === "visiting") {
      throw new Error(`Cycle detected in conduit steps involving "${step.id}"`);
    }
    state.set(step.id, "visiting");
    for (const dep of step.needs ?? []) {
      const parent = byId.get(dep);
      if (parent) visit(parent);
    }
    state.set(step.id, "done");
    order.push(step);
  };
  for (const step of steps) visit(step);
  return order;
}

export function buildWaves(steps: readonly ConduitStep[]): ConduitStep[][] {
  const level = new Map<string, number>();
  const waves: ConduitStep[][] = [];
  for (const step of topoSort(steps)) {
    const deps = step.needs ?? [];
    const depth = deps.length ? Math.max(...deps.map((dep) => level.get(dep)!)) + 1 : 0;
    level.set(step.id, depth);
    waves[depth] ??= [];
    waves[depth].push(step);
  }
  return waves;
}

function wrapValidation(label: string, validate?: Validator) {
  return (value: unknown) => {
    try {
      validate?.(value);
    } catch (err) {
      throw new Error(`${label}: ${err instanceof Error ? err.message : err}`);
    }
  };
}

function buildCacheKey(method: string, url: string, query?: Record<string, unknown>): string {
  if (!query || Object.keys(query).length === 0) return `${method} ${url}`;
  const params = buildSearchParams(query as Record<string, any>);
  params.sort();
  return `${method} ${url}?${params.toString()}`;
}

async function runStep(
  step: ConduitStep,
  context: ConduitContext,
  validateOutput: (value: unknown) => void,
  cache: ConduitCache,
  inflight: Map<string, Promise<unknown>>,
  opts: ExecuteOptions,
): Promise<unknown> {
  const url = await evalExpr<string>(step.url, context);
  if (typeof url !== "string" || !url) {
    throw new Error(`Step "${step.id}": url must evaluate to a non-empty string`);
  }
  const method = step.method;

  let query: Record<string, unknown> | undefined;
  if (step.query_transform != null) {
    const result = await evalExpr(step.query_transform, context);
    if (result != null && (typeof result !== "object" || Array.isArray(result))) {
      throw new Error(`Step "${step.id}": query_transform must evaluate to an object`);
    }
    query = (result ?? undefined) as Record<string, unknown> | undefined;
  }

  // GET-only opt-in cache. `cache_ttl: 0` (or omitted) disables caching.
  const ttl = step.method === "GET" ? (step.cache_ttl ?? 0) : 0;
  const key = ttl > 0 ? buildCacheKey(method, url, query) : undefined;
  if (key !== undefined) {
    const hit = cache.get(key);
    if (hit) {
      if (Date.now() < hit.expires) {
        console.error("[conduit] Step %s %s %s -> cached", step.id, method, url);
        return hit.data;
      }
      cache.delete(key);
    }
    const pending = inflight.get(key);
    if (pending) {
      console.error("[conduit] Step %s %s %s -> cached", step.id, method, url);
      return pending;
    }
  }

  const doFetch = async (): Promise<unknown> => {
    const stepHeaders: Record<string, string> = {};
    for (const [name, src] of Object.entries(step.headers ?? {})) {
      stepHeaders[name] = String(await evalExpr(src, context));
    }
    const headers = resolveHeaders(opts.headers, stepHeaders);

    let json: unknown;
    if (method !== "GET" && step.body_transform != null) {
      json = await evalExpr(step.body_transform, context);
    }

    let data: unknown;
    const startedAt = Date.now();
    try {
      const res = simpleRequest(url, {
        method,
        headers,
        searchParams: query as Record<string, any>,
        ...(json !== undefined ? { json } : {}),
      });
      const text = await res.text();
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    } catch (err) {
      throw new Error(`Step "${step.id}" failed (${method} ${url}): ${err}`, { cause: err });
    }
    validateOutput(data);
    // Progress/diagnostic output goes to stderr so piped stdout stays pure data.
    console.error("[conduit] Step %s %s %s -> %dms", step.id, method, url, Date.now() - startedAt);
    return data;
  };

  if (key === undefined) return doFetch();
  const pending = doFetch();
  inflight.set(key, pending);
  try {
    const data = await pending;
    cache.set(key, { expires: Date.now() + ttl * 1000, data });
    return data;
  } finally {
    inflight.delete(key);
  }
}

export async function executeConduit(
  def: Conduit,
  input: unknown,
  opts: ExecuteOptions = {},
): Promise<unknown> {
  const env = opts.env ?? process.env;
  const validateInput = wrapValidation(
    `Conduit "${def.name}" input`,
    makeValidator(def.input_schema),
  );
  const validateFinal = wrapValidation(
    `Conduit "${def.name}" output`,
    makeValidator(def.output_schema),
  );

  validateInput(input);

  const cache: ConduitCache = opts.cache ?? new Map();
  const inflight = new Map<string, Promise<unknown>>();
  const context: ConduitContext = { input, steps: {}, env };
  for (const wave of buildWaves(def.steps)) {
    await Promise.all(
      wave.map(async (step) => {
        context.steps[step.id] = await runStep(
          step,
          context,
          wrapValidation(
            `Step "${step.id}" output validation failed`,
            makeValidator(step.output_schema),
          ),
          cache,
          inflight,
          opts,
        );
      }),
    );
  }

  let output: unknown;
  try {
    output = await evalExpr(def.output_transform, context);
  } catch (err) {
    throw new Error(`Conduit "${def.name}" output_transform failed: ${err}`, { cause: err });
  }
  validateFinal(output);
  return output;
}
