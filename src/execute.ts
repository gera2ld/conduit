import { simpleRequest } from "@gera2ld/common";
import { evalExpr } from "./jsonata";
import { makeValidator, type Validator } from "./validate";
import type { Conduit, ConduitStep } from "./types";

export interface ConduitContext {
  input: unknown;
  steps: Record<string, unknown>;
  env: Record<string, string | undefined>;
}

export interface ExecuteOptions {
  env?: Record<string, string | undefined>;
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

async function runStep(
  step: ConduitStep,
  context: ConduitContext,
  validateOutput: (value: unknown) => void,
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

  const headers: Record<string, string> = {};
  for (const [name, src] of Object.entries(step.headers ?? {})) {
    headers[name] = String(await evalExpr(src, context));
  }

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
