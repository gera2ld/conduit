/**
 * Syncs the Go embed copy from the canonical corpus.
 *
 *   bun run spec/sync-parity.ts
 *
 * Run after `bun run spec/gen-parity-cases.ts`. The Go test embeds
 * packages/conduit-go/testdata/parity.json rather than reading the shared file
 * at test time, because Go's test cache does not track files outside the package
 * and would return a stale pass.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const SRC = new URL("./jsonata-parity/cases.json", import.meta.url);
const DEST = new URL("../packages/conduit-go/testdata/parity.json", import.meta.url);

const data = await readFile(SRC);
await mkdir(dirname(DEST.pathname), { recursive: true });
await writeFile(DEST, data);

const cases = JSON.parse(data.toString()) as { out: unknown[] };
console.log(`synced ${cases.out.length} cases -> packages/conduit-go/testdata/parity.json`);
