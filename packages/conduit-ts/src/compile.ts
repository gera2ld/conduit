import { executeConduit, type ExecuteOptions } from "./execute";
import type { Conduit } from "./types";

export type ConduitFunction = (input: unknown, opts?: ExecuteOptions) => Promise<unknown>;

/**
 * Compile a conduit definition into a plain async function that takes the
 * tool/API input and resolves to the transformed output. Binding it to a
 * specific framework (AI SDK tool, HTTP route) is left to the consumer.
 */
export function compileConduit(def: Conduit): ConduitFunction {
  return async (input, opts = {}) => executeConduit(def, input, opts);
}
