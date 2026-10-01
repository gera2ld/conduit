import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import jsonata from "jsonata";
import { SCHEMA_PATH } from "./harness";

const PARITY_PATH = new URL("./jsonata-parity/cases.json", import.meta.url).pathname;
const EMBED_COPY_PATH = new URL("../packages/conduit-go/testdata/parity.json", import.meta.url)
  .pathname;

interface ParityCase {
  expr: string;
  got: string;
}
interface Parity {
  ctx: unknown;
  out: ParityCase[];
}

const parity = JSON.parse(await readFile(PARITY_PATH, "utf8")) as Parity;

/**
 * The shared parity file records what jsonata-js returns. This test keeps that
 * honest from the TypeScript side, so the file cannot drift into describing some
 * other engine's behavior. The Go twin is packages/conduit-go/jsonata_parity_test.go.
 */
describe("jsonata engine parity", () => {
  test("the shared parity file still describes jsonata-js", async () => {
    expect(parity.out.length).toBeGreaterThan(0);
    const mismatches: string[] = [];
    for (const c of parity.out) {
      let got: string;
      try {
        const value = await jsonata(c.expr).evaluate(parity.ctx);
        got = JSON.stringify(value ?? null);
      } catch (err) {
        got = `ERROR: ${(err as Error).message}`;
      }
      if (got !== c.got)
        mismatches.push(`  ${c.expr}\n    recorded: ${c.got}\n    actual:   ${got}`);
    }
    expect(mismatches.join("\n")).toBe("");
  });

  test("the Go embed copy is in sync with the shared corpus", async () => {
    // This guard lives here, not in Go, on purpose: Go's test cache only tracks
    // files inside the package directory, so a Go test reading the shared corpus
    // returns a STALE PASS once the corpus changes. bun does not cache.
    const embedded = await readFile(EMBED_COPY_PATH, "utf8");
    expect(embedded).toBe(await readFile(PARITY_PATH, "utf8"));
  });

  test("the parity set covers the constructs the corpus depends on", () => {
    const exprs = parity.out.map((c) => c.expr).join("\n");
    // Each of these is pinned by a conduit fixture; if the engine changes
    // behavior on one, the Go implementation would diverge silently.
    for (const needle of [
      "{ name:", // unquoted key must be dropped
      "headers.x-api-key", // undefined path must be silent
      "??", // null coalescing
      "$lookup", // hyphenated key access
      "$map", // the only correct mapping form
      ".id[]", // array-forcing suffix
      '{ "id": id }', // bare {} must not map
    ]) {
      expect(exprs).toContain(needle);
    }
  });
});

describe("spec artifacts", () => {
  test("the published schema is valid JSON and compiles under ajv 2020", async () => {
    const { default: Ajv2020 } = await import("ajv/dist/2020.js");
    const schema = JSON.parse(await readFile(SCHEMA_PATH, "utf8"));
    expect(() => new Ajv2020({ strict: false }).compile(schema)).not.toThrow();
  });
});
