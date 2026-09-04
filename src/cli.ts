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

async function loadConduitFile(path: string): Promise<ReturnType<typeof parseConduit>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(
      `Cannot read conduit file "${path}": ${err instanceof Error ? err.message : err}`,
    );
  }
  let raw: unknown;
  try {
    raw = path.endsWith(".json") ? JSON.parse(text) : loadYaml(text);
  } catch (err) {
    throw new Error(
      `Cannot parse conduit file "${path}": ${err instanceof Error ? err.message : err}`,
    );
  }
  return parseConduit(raw);
}

async function loadInput(opts: RunOptions, cmd: Command): Promise<unknown> {
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
  if (isStdinPiped()) {
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
  .command("run <conduit-file>")
  .description(
    "Execute a conduit (env comes from process.env; use `bun --env-file=.env` to load a file)",
  )
  .option("-i, --input <json>", "Input payload as an inline JSON string")
  .option("-f, --input-file <path>", "Input payload file (.json/.yaml/.yml, or - for stdin)")
  .option("--validate-only", "Only parse and validate the conduit without executing")
  .action(async (conduitFile: string, opts: RunOptions, cmd: Command) => {
    try {
      const def = await loadConduitFile(conduitFile);
      if (opts.validateOnly) {
        console.log(`✓ ${def.name}: ${def.steps.length} steps valid (not executed)`);
        return;
      }
      const input = await loadInput(opts, cmd);
      const output = await executeConduit(def, input);
      console.log(JSON.stringify(output, null, 2));
    } catch (err) {
      const { ZodError } = await import("zod");
      if (err instanceof ZodError) {
        cmd.error(`error: invalid conduit: ${err.message}`, { exitCode: 1 });
      }
      if (err instanceof Error && /^(Cannot read|Cannot parse|invalid conduit)/.test(err.message)) {
        cmd.error(`error: ${err.message}`, { exitCode: 1 });
      }
      process.stderr.write(`error: ${err instanceof Error ? err.message : err}\n`);
      process.exit(2);
    }
  });

program
  .command("validate <conduit-file>")
  .description("Parse and validate a conduit without executing it")
  .action(async (conduitFile: string, _opts: unknown, cmd: Command) => {
    try {
      const def = await loadConduitFile(conduitFile);
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
