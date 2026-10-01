import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const CLI = new URL("./cli.ts", import.meta.url).pathname;

let baseUrl = "";
let server: ReturnType<typeof Bun.serve>;

const pingYaml = () => `name: ping
steps:
  - id: s
    url: '"${baseUrl}/ping"'
output_transform: steps.s
`;

const pingJson = () => ({
  name: "ping",
  steps: [{ id: "s", url: `"${baseUrl}/ping"` }],
  output_transform: "steps.s",
});

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      switch (url.pathname) {
        case "/conduit.yaml":
          return new Response(pingYaml());
        case "/conduit.json":
          return Response.json(pingJson());
        case "/ping":
          return Response.json({ pong: true });
        default:
          return new Response("nope", { status: 404 });
      }
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

interface CliResult {
  exit: number;
  out: string;
  err: string;
}

async function runCli(args: string[], stdin?: string): Promise<CliResult> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exit, out, err };
}

describe("cli conduit sources", () => {
  test("validates a conduit served as YAML over HTTP", async () => {
    const r = await runCli(["validate", `${baseUrl}/conduit.yaml`]);
    expect(r.exit).toBe(0);
    expect(r.out).toContain("✓ ping");
  });

  test("validates a conduit served as JSON over HTTP", async () => {
    const r = await runCli(["validate", `${baseUrl}/conduit.json`]);
    expect(r.exit).toBe(0);
    expect(r.out).toContain("✓ ping");
  });

  test("runs a conduit fetched from a URL", async () => {
    const r = await runCli(["run", `${baseUrl}/conduit.yaml`, "-i", "{}"]);
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ pong: true });
  });

  test("exits 1 for a URL that 404s", async () => {
    const r = await runCli(["validate", `${baseUrl}/nope`]);
    expect(r.exit).toBe(1);
    expect(r.err).toContain("HTTP 404");
  });

  test("reads the conduit from stdin with an explicit -", async () => {
    const r = await runCli(["run", "-", "-i", "{}"], pingYaml());
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ pong: true });
  });

  test("reads the conduit from piped stdin when the arg is omitted", async () => {
    const r = await runCli(["validate"], pingYaml());
    expect(r.exit).toBe(0);
    expect(r.out).toContain("✓ ping");
  });

  test("rejects input from stdin when stdin already provides the conduit", async () => {
    const r = await runCli(["run", "-", "-f", "-"], pingYaml());
    expect(r.exit).toBe(1);
    expect(r.err).toContain("already provides the conduit");
  });

  test("rejects empty stdin as a conduit definition", async () => {
    const empty = await runCli(["validate", "-"], "");
    expect(empty.exit).toBe(1);
    expect(empty.err).toContain("empty conduit definition");

    const omitted = await runCli(["validate"], "");
    expect(omitted.exit).toBe(1);
    expect(omitted.err).toContain("empty conduit definition");
  });

  test("still accepts a plain file path", async () => {
    const example = new URL("../examples/user-posts.yaml", import.meta.url).pathname;
    const r = await runCli(["validate", example]);
    expect(r.exit).toBe(0);
    expect(r.out).toContain("✓ user_posts");
  });
});
