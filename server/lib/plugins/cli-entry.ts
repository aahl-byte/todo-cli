// The CLI's way into the plugin host: a run's input as JSON on stdin, its
// RunResult as JSON on stdout. A failed run still exits 0; unreadable input exits 2.
// This process is the sandbox's isolation, so code plugins run in it directly.
import { hostFailure } from "./sandbox.mjs";
import { runInstance } from "./host";
import type { RunInput, RunResult } from "./types";

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

async function readStdin(): Promise<string> {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

/** The input, or what's wrong with it. */
export function parseInput(text: string): RunInput | string {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (e) {
    return `input isn't JSON: ${(e as Error).message}`;
  }
  if (!isMap(input)) return "input must be a JSON object";
  for (const k of ["plugin", "instance", "item", "event"]) if (!isMap(input[k])) return `input needs ${k} as an object`;
  if (input.connections !== undefined && !isMap(input.connections)) return "connections must be an object";
  return { ...input, connections: input.connections ?? {}, dryRun: input.dryRun === true } as RunInput;
}

const failed = (e: unknown): RunResult => ({ attached: [], wouldSend: [], log: [], error: `the plugin host failed: ${hostFailure(e)}` });

/** Whatever goes wrong, the CLI reads one result and this process ends. */
let answered = false;
function answer(result: RunResult): void {
  if (answered) return;
  answered = true;
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
}

async function main() {
  process.on("uncaughtException", (e) => answer(failed(e)));
  process.on("unhandledRejection", (e) => answer(failed(e)));
  const input = parseInput(await readStdin());
  if (typeof input === "string") {
    process.stderr.write(`plugin host: ${input}\n`);
    process.exit(2);
  }
  answer(await runInstance(input, { isolation: "inline" }).catch(failed));
}

void main();
