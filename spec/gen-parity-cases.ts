/**
 * Regenerates spec/jsonata-parity/cases.json.
 *
 * The recorded `got` values MUST come from jsonata-js, never from a human: the
 * file is the contract a second expression engine is measured against, and
 * spec/parity.test.ts verifies it against jsonata-js on every run. Hand-writing
 * the expectations would just be a second place to be wrong.
 *
 *   bun run spec/gen-parity-cases.ts
 */
import { writeFile } from "node:fs/promises";
import jsonata from "jsonata";

/** Two shapes, mirroring the one-match and two-match corpus fixtures. */
const ctx = {
  input: { nullable: null, user_id: 7 },
  env: { API_TOKEN: "tok" },
  steps: {
    user: { name: "Gerald" },
    // exactly one order over 100
    one: {
      orders: [
        { id: "o1", price: 250, qty: 2 },
        { id: "o2", price: 50, qty: 1 },
      ],
    },
    // two orders over 100
    many: {
      orders: [
        { id: "o1", price: 250, qty: 2 },
        { id: "o2", price: 50, qty: 1 },
        { id: "o3", price: 120, qty: 5 },
      ],
    },
    r: { headers: { "x-api-key": "secret", accept: "*/*" } },
  },
};

/**
 * Every construct a conduit fixture depends on. Keep in sync with the coverage
 * assertions in spec/parity.test.ts.
 */
const exprs = [
  // unquoted object key: jsonata-js reads `name` as a field reference, fails to
  // resolve it, and drops the pair -> {}
  `{ name: steps.user.name }`,
  `{ "name": steps.user.name }`,

  // undefined path access is silent in jsonata-js
  `steps.r.headers.x-api-key`,
  `steps.user.missing.deep`,

  // projection collapses to a scalar on exactly one match
  `steps.one.orders[price > 100].id`,
  `steps.many.orders[price > 100].id`,
  // ...and the trailing [] forces an array either way
  `steps.one.orders[price > 100].id[]`,
  `steps.many.orders[price > 100].id[]`,

  // a bare {} does not map over a sequence
  `steps.many.orders{ "id": id }`,
  // the correct mapping form
  `$map(steps.many.orders, function($o) { { "id": $o.id, "total": $o.price * $o.qty } })`,

  // `??` catches a missing key, not an explicit null
  `input.limit ?? 25`,
  `input.nullable ?? 25`,

  // hyphenated keys need $lookup; dot and bracket both fail silently
  `steps.r.headers.x-api-key ?? "absent"`,
  `$type(steps.r.headers["x-api-key"])`,
  `$lookup(steps.r.headers, "x-api-key")`,

  // string building and numeric coercion
  `"Bearer " & (env.API_TOKEN ?? "")`,
  `"https://api.example.com/users/" & $string(input.user_id)`,
];

const out: { expr: string; got: string }[] = [];
for (const expr of exprs) {
  try {
    const value = await jsonata(expr).evaluate(ctx);
    out.push({ expr, got: JSON.stringify(value ?? null) });
  } catch (err) {
    out.push({ expr, got: `ERROR: ${(err as Error).message}` });
  }
}

const path = new URL("./jsonata-parity/cases.json", import.meta.url).pathname;
await writeFile(path, JSON.stringify({ ctx, out }, null, 2) + "\n");
console.log(`wrote ${out.length} cases to spec/jsonata-parity/cases.json`);
for (const o of out) console.log(`  ${o.expr.padEnd(64)} => ${o.got}`);
