import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { load as loadYaml } from "js-yaml";
import { readFile } from "node:fs/promises";
import { loadFixtures, runFixture, SCHEMA_PATH } from "./harness";
import { conduitSchema } from "../src/types";

// The timeout fixture costs an 11s wait, so it is opt-in via env var — a CLI
// flag does not reach the bun test worker reliably.
const includeSlow = process.env.CONDUIT_SPEC_SLOW === "1";

const schema = JSON.parse(await readFile(SCHEMA_PATH, "utf8"));

describe("conformance corpus", () => {
  test(
    "every fixture passes",
    async () => {
      const fixtures = await loadFixtures({ includeSlow });
      expect(fixtures.length).toBeGreaterThan(0);
      const results = [];
      for (const fixture of fixtures) results.push(await runFixture(fixture));
      const failures = results.filter((r) => !r.ok);
      const detail = failures.map((f) => `  ${f.name}: ${f.detail}`).join("\n");
      expect(`${results.length - failures.length}/${results.length} passed\n${detail}`).toBe(
        `${results.length}/${results.length} passed\n`,
      );
    },
    // The timeout fixture alone waits 11s.
    includeSlow ? 60_000 : 15_000,
  );
});

/**
 * The published JSON Schema and the runtime Zod parser must agree. Without this
 * they drift apart, and editors start rejecting definitions that run fine.
 */
describe("schema agrees with the runtime parser", () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile(schema);

  const accepts = (raw: unknown) => {
    const schemaOk = validate(raw);
    const zodOk = conduitSchema.safeParse(raw).success;
    return { schemaOk, zodOk };
  };

  const base = (over: Record<string, unknown> = {}) => ({
    name: "c",
    steps: [{ id: "s", url: '"https://example.com"' }],
    output_transform: "steps.s",
    ...over,
  });

  const baseStep = (over: Record<string, unknown> = {}) => ({
    id: "s",
    url: '"https://example.com"',
    ...over,
  });

  const cases: [string, unknown][] = [
    ["minimal valid", base()],
    ["with $schema", base({ $schema: "https://example.com/s.json" })],
    ["with description", base({ description: "d" })],
    ["with input/output schemas", base({ input_schema: { type: "object" }, output_schema: {} })],
    [
      "all step fields",
      base({
        steps: [
          baseStep({
            method: "POST",
            headers: { authorization: '"Bearer x"' },
            query_transform: '{ "a": 1 }',
            body_transform: '{ "b": 2 }',
            needs: ["t"],
            cache_ttl: 30,
            output_schema: { type: "object" },
          }),
          baseStep({ id: "t" }),
        ],
      }),
    ],
    ["cache_ttl zero is valid", base({ steps: [baseStep({ cache_ttl: 0 })] })],
    ["unknown step key is allowed", base({ steps: [baseStep({ bogus: 1 })] })],

    ["missing name", { steps: [{ id: "s", url: "u" }], output_transform: "1" }],
    ["empty name", base({ name: "" })],
    ["missing steps", { name: "c", output_transform: "1" }],
    ["empty steps", base({ steps: [] })],
    ["missing output_transform", base({ output_transform: undefined })],
    ["empty output_transform", base({ output_transform: "" })],
    ["unknown top-level key", base({ typo: true })],
    ["step missing id", base({ steps: [{ url: "u" }] })],
    ["step missing url", base({ steps: [{ id: "s" }] })],
    ["empty step id", base({ steps: [baseStep({ id: "" })] })],
    ["empty step url", base({ steps: [baseStep({ url: "" })] })],
    ["bad method", base({ steps: [baseStep({ method: "HEAD" })] })],
    ["lowercase method", base({ steps: [baseStep({ method: "get" })] })],
    ["negative cache_ttl", base({ steps: [baseStep({ cache_ttl: -5 })] })],
    ["string cache_ttl", base({ steps: [baseStep({ cache_ttl: "300" })] })],
    ["non-string header value", base({ steps: [baseStep({ headers: { a: 1 } })] })],
    ["needs not an array", base({ steps: [baseStep({ needs: "t" })] })],
  ];

  for (const [label, raw] of cases) {
    test(label, () => {
      const { schemaOk, zodOk } = accepts(raw);
      expect({ label, schemaOk, zodOk }).toEqual({ label, schemaOk: zodOk, zodOk });
    });
  }

  // Rules JSON Schema cannot express: enforced only by the runtime parser.
  test("runtime-only rules are outside the schema's remit", async () => {
    const duplicateIds = base({ steps: [baseStep(), baseStep()] });
    expect(conduitSchema.safeParse(duplicateIds).success).toBe(false);
    expect(validate(duplicateIds)).toBe(true);

    const danglingNeeds = base({ steps: [baseStep({ needs: ["ghost"] })] });
    expect(conduitSchema.safeParse(danglingNeeds).success).toBe(false);
    expect(validate(danglingNeeds)).toBe(true);
  });

  // Every fixture definition must be accepted by both, or a fixture is invalid.
  test("all corpus definitions validate against the published schema", async () => {
    const fixtures = (await loadFixtures({ includeSlow: true })).filter(
      (f) => !f.invalidDefinition,
    );
    const bad: string[] = [];
    for (const fixture of fixtures) {
      // Substitute a placeholder origin so the definition parses standalone.
      const raw = loadYaml(fixture.source.split("{{base_url}}").join("https://example.test"));
      if (!validate(raw)) bad.push(`${fixture.name}: ${ajv.errorsText(validate.errors)}`);
    }
    expect(bad).toEqual([]);
  });
});
