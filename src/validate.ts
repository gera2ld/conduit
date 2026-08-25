import Ajv from "ajv";
import { Logger } from "@gera2ld/common";

const logger = new Logger("[conduit]");

export type Validator = (value: unknown) => void;

interface CacheEntry {
  validator?: Validator;
}

const ajv = new Ajv({ strict: false });
const cache = new WeakMap<object, CacheEntry>();

/**
 * Build a validator for a (possibly invalid or absent) JSON schema.
 * Returns undefined when no validation should run; a provided-but-invalid
 * schema is skipped with a warning.
 */
export function makeValidator(schema: unknown): Validator | undefined {
  if (schema == null || typeof schema !== "object") return undefined;
  let entry = cache.get(schema);
  if (!entry) {
    entry = {};
    try {
      const validate = ajv.compile(schema as Parameters<typeof ajv.compile>[0]);
      entry.validator = (value) => {
        if (!validate(value)) {
          throw new Error(ajv.errorsText(validate.errors));
        }
      };
    } catch (err) {
      logger.error("Ignoring invalid JSON schema (%s)", err instanceof Error ? err.message : err);
    }
    cache.set(schema, entry);
  }
  return entry.validator;
}
