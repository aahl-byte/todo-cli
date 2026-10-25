// The CLI's way into the plugin host: JSON on stdin, JSON on stdout. By default
// the input is one instance's run and the output its RunResult; with
// "mode": "event" it is an event for runEvent and the output its EventResult.
// A failed run still exits 0; unreadable input exits 2.
// This process is the sandbox's isolation, so code plugins run in it directly.
import { hostFailure } from "./sandbox.mjs";
import { runEvent, runInstance, type EventInput, type EventResult } from "./host";
import type { RunInput, RunResult } from "./types";

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

async function readStdin(): Promise<string> {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

type Parsed = { mode: "instance"; input: RunInput } | { mode: "event"; input: EventInput };

const EVENT_MAPS = ["hostConnections", "secrets", "storedInstances", "grants", "limits"];

/** The input, or what's wrong with it. */
export function parseInput(text: string): Parsed | string {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (e) {
    return `input isn't JSON: ${(e as Error).message}`;
  }
  if (!isMap(input)) return "input must be a JSON object";
  const { mode = "instance", ...rest } = input;
  if (mode === "event") {
    for (const k of ["item", "event"]) if (!isMap(rest[k])) return `input needs ${k} as an object`;
    for (const k of EVENT_MAPS) if (rest[k] !== undefined && !isMap(rest[k])) return `${k} must be an object`;
    if (rest.repoKey !== undefined && typeof rest.repoKey !== "string") return "repoKey must be a string";
    const repo = rest.repo;
    if (repo !== undefined && !(isMap(repo) && typeof repo.text === "string" && (repo.files === undefined || isMap(repo.files)))) {
      return "repo must be {text, files}";
    }
    return { mode, input: { ...rest, repo: repo && { files: {}, ...repo }, dryRun: rest.dryRun === true } as EventInput };
  }
  if (mode !== "instance") return `unknown mode ${JSON.stringify(mode)}`;
  for (const k of ["plugin", "instance", "item", "event"]) if (!isMap(rest[k])) return `input needs ${k} as an object`;
  if (rest.connections !== undefined && !isMap(rest.connections)) return "connections must be an object";
  return { mode, input: { ...rest, connections: rest.connections ?? {}, dryRun: rest.dryRun === true } as RunInput };
}

let mode: Parsed["mode"] = "instance";
const failed = (e: unknown): RunResult | EventResult => {
  const error = `the plugin host failed: ${hostFailure(e)}`;
  return mode === "event" ? { results: [], errors: [error], track: [] } : { attached: [], wouldSend: [], log: [], error };
};

/** Whatever goes wrong, the CLI reads one result and this process ends. */
let answered = false;
function answer(result: RunResult | EventResult): void {
  if (answered) return;
  answered = true;
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
}

async function main() {
  process.on("uncaughtException", (e) => answer(failed(e)));
  process.on("unhandledRejection", (e) => answer(failed(e)));
  const parsed = parseInput(await readStdin());
  if (typeof parsed === "string") {
    process.stderr.write(`plugin host: ${parsed}\n`);
    process.exit(2);
  }
  mode = parsed.mode;
  const deps = { isolation: "inline" as const };
  answer(await (parsed.mode === "event" ? runEvent(parsed.input, deps) : runInstance(parsed.input, deps)).catch(failed));
}

void main();
