import type { Calls } from "./connections";
import type { Attachment, PluginDef, PluginEvent, PluginItem, RunResult } from "./types";

export interface CodeRun {
  plugin: PluginDef;
  code: string;
  item: PluginItem;
  event: PluginEvent;
  settings: Record<string, unknown>;
  calls: Calls;
  result: RunResult;
  deadline: number;
  memoryBytes?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function runCode(_run: CodeRun): Promise<Attachment[]> {
  throw new Error("code plugins aren't supported yet");
}
