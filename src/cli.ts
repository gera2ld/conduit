#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { load as loadYaml } from "js-yaml";
import { executeConduit } from "./execute";
import { parseConduit } from "./types";
import pkg from "../package.json" with { type: "json" };

interface RunOptions {
  input?: string;
  inputFile?: string;
  validateOnly?: boolean;
}

function isStdinPiped(): boolean {
  return !process.stdin.isTTY;
}

async function readStdinText(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

function parsePayloadText(text: string, label: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    try {
      return loadYaml(trimmed);
    } catch {
      throw new Error(`${label}: not valid JSON or YAML`);
    }
  }
}

async function loadConduit(
  source: string | undefined,
  cmd: Command,
): Promise<{ def: ReturnType<typeof parseConduit>; fromStdin: boolean }> {
  if (source === undefined && !isStdinPiped()) {
    cmd.error("error: missing required argument 'conduit-file'", { exitCode: 1 });
  }
  const resolved = source ?? "-";
  const { text, contentType } = await readConduitText(resolved);
  const label =
    resolved === "-"
      ? "stdin"
      : isConduitUrl(resolved)
        ? `conduit URL "${resolved}"`
        : `conduit file "${resolved}"`;
  const format =
    resolved === "-"
      ? "sniff"
      : isConduitUrl(resolved)
        ? urlFormatHint(contentType)
        : resolved.endsWith(".json")
          ? "json"
          : "yaml";
  return { def: parseConduit(parseConduitText(text, label, format)), fromStdin: resolved === "-" };
}

function isConduitUrl(source: string): boolean {
  try {
    const url = new URL(source);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function readConduitText(source: string): Promise<{ text: string; contentType?: string }> {
  if (source === "-") return { text: await readStdinText() };
  if (isConduitUrl(source)) {
    // A remote definition dictates arbitrary HTTP requests on execution —
    // treat conduit URLs like code and prefer pinned revisions.
    let res: Response;
    try {
      res = await fetch(source, { signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      throw new Error(
        `Cannot fetch conduit URL "${source}": ${err instanceof Error ? err.message : err}`,
      );
    }
    if (!res.ok) {
      throw new Error(`Cannot fetch conduit URL "${source}": HTTP ${res.status}`);
    }
    return { text: await res.text(), contentType: res.headers.get("content-type") ?? undefined };
  }
  try {
    return { text: await readFile(source, "utf8") };
  } catch (err) {
    throw new Error(
      `Cannot read conduit file "${source}": ${err instanceof Error ? err.message : err}`,
    );
  }
}

function urlFormatHint(contentType?: string): "json" | "yaml" | "sniff" {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("json")) return "json";
  if (ct.includes("yaml")) return "yaml";
  return "sniff";
}

function parseConduitText(text: string, label: string, format: "json" | "yaml" | "sniff"): unknown {
  if (!text.trim()) throw new Error(`Cannot parse ${label}: empty conduit definition`);
  try {
    if (format === "json") return JSON.parse(text);
    if (format === "yaml") return loadYaml(text);
    try {
      return JSON.parse(text);
    } catch {
      return loadYaml(text);
    }
  } catch (err) {
    throw new Error(`Cannot parse ${label}: ${err instanceof Error ? err.message : err}`);
  }
}

async function loadInput(opts: RunOptions, cmd: Command, stdinTaken = false): Promise<unknown> {
  if (opts.input !== undefined && opts.inputFile !== undefined) {
    cmd.error("error: --input and --input-file cannot be used together", { exitCode: 1 });
  }
  if (opts.input !== undefined) {
    try {
      return JSON.parse(opts.input);
    } catch (err) {
      cmd.error(`error: --input is not valid JSON: ${err instanceof Error ? err.message : err}`, {
        exitCode: 1,
      });
    }
  }
  if (opts.inputFile !== undefined) {
    const p = opts.inputFile;
    if (p === "-" && stdinTaken) {
      cmd.error(
        "error: stdin already provides the conduit; pass input via -i or --input-file <path>",
        { exitCode: 1 },
      );
    }
    const text =
      p === "-"
        ? await readStdinText()
        : await readFile(p, "utf8").catch((err: unknown) => {
            cmd.error(
              `error: cannot read input file "${p}": ${err instanceof Error ? err.message : err}`,
              {
                exitCode: 1,
              },
            );
          });
    try {
      if (p.endsWith(".json") || (p === "-" && text.trim().startsWith("{"))) {
        return text.trim() ? JSON.parse(text) : {};
      }
      if (p.endsWith(".yaml") || p.endsWith(".yml")) {
        const v = loadYaml(text);
        return v === undefined ? {} : v;
      }
      return parsePayloadText(text, `input file "${p}"`);
    } catch (err) {
      cmd.error(
        `error: cannot parse input file "${p}": ${err instanceof Error ? err.message : err}`,
        { exitCode: 1 },
      );
    }
  }
  if (!stdinTaken && isStdinPiped()) {
    const text = await readStdinText();
    if (!text.trim()) return {};
    try {
      return parsePayloadText(text, "stdin");
    } catch (err) {
      cmd.error(`error: ${err instanceof Error ? err.message : err}`, { exitCode: 1 });
    }
  }
  return {};
}

const program = new Command();
program
  .name("conduit")
  .description("Run a conduit definition against a given input")
  .version((pkg as { version: string }).version);

program
  .command("run [conduit-file]")
  .description(
    "Execute a conduit from a file, URL, or stdin (env comes from process.env; use `bun --env-file=.env` to load a file)",
  )
  .option("-i, --input <json>", "Input payload as an inline JSON string")
  .option("-f, --input-file <path>", "Input payload file (.json/.yaml/.yml, or - for stdin)")
  .option("--validate-only", "Only parse and validate the conduit without executing")
  .action(async (conduitFile: string | undefined, opts: RunOptions, cmd: Command) => {
    try {
      const { def, fromStdin } = await loadConduit(conduitFile, cmd);
      if (opts.validateOnly) {
        console.log(`✓ ${def.name}: ${def.steps.length} steps valid (not executed)`);
        return;
      }
      const input = await loadInput(opts, cmd, fromStdin);
      const output = await executeConduit(def, input);
      console.log(JSON.stringify(output, null, 2));
    } catch (err) {
      const { ZodError } = await import("zod");
      if (err instanceof ZodError) {
        cmd.error(`error: invalid conduit: ${err.message}`, { exitCode: 1 });
      }
      if (
        err instanceof Error &&
        /^(Cannot (read|parse|fetch)|invalid conduit)/.test(err.message)
      ) {
        cmd.error(`error: ${err.message}`, { exitCode: 1 });
      }
      process.stderr.write(`error: ${err instanceof Error ? err.message : err}\n`);
      process.exit(2);
    }
  });

program
  .command("validate [conduit-file]")
  .description("Parse and validate a conduit (file, URL, or stdin) without executing it")
  .action(async (conduitFile: string | undefined, _opts: unknown, cmd: Command) => {
    try {
      const { def } = await loadConduit(conduitFile, cmd);
      console.log(`✓ ${def.name}: ${def.steps.length} steps valid`);
    } catch (err) {
      const { ZodError } = await import("zod");
      if (err instanceof ZodError) {
        cmd.error(`error: invalid conduit: ${err.message}`, { exitCode: 1 });
      }
      cmd.error(`error: ${err instanceof Error ? err.message : err}`, { exitCode: 1 });
    }
  });

await program.parseAsync(process.argv);
