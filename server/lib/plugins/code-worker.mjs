// A worker thread that runs one code plugin's sandbox, asking the parent for
// every host call, so a crash in the sandbox ends only this thread.
import { parentPort, workerData } from "node:worker_threads";
import { runSandbox } from "./sandbox.mjs";

let next = 0;
const waiting = new Map();
parentPort.on("message", ({ id, value }) => {
  const done = waiting.get(id);
  waiting.delete(id);
  done?.(value);
});
const ask = (op, args) => new Promise((done) => {
  const id = next++;
  waiting.set(id, done);
  parentPort.postMessage({ op, id, args });
});

const out = await runSandbox(workerData, {
  call: (connection, call) => ask("call", [connection, call]),
  attach: (kind, fields) => ask("attach", [kind, fields]),
  sleep: (ms) => ask("sleep", [ms]),
});
parentPort.postMessage({ op: "done", ...out });
