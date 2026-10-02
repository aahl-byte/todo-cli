// Demo data for trying the dashboard locally: three users, one project, a
// handful of items across the lifecycle. Prints each user's token.
import { applyOps, type Op } from "../lib/apply";
import { addProject, addUser } from "../lib/auth";
import { db } from "../lib/db";
import { ulid } from "../lib/ulid";

const d = await db();
const tokens: Record<string, string> = {};
for (const h of ["pat", "dev", "qa"]) tokens[h] = await addUser(d, h, { pat: "Pat (PM)", dev: "Dana (dev)", qa: "Quinn (QA)" }[h]);
await addProject(d, "web", "Web app");

const now = () => new Date().toISOString();
async function run(who: string, ops: Partial<Op>[]) {
  return applyOps(d, "web", ops.map((o) => ({ op_id: ulid(), via: "human", ...o }) as Op), { handle: who });
}
async function item(who: string, title: string, data: Record<string, unknown>, request?: string) {
  const uid = ulid();
  await run(who, [{ op: "create", entity: "item", uid, item_uid: uid, data: { title, created: now(), ...data } }]);
  if (request) await run(who, [{ op: "create", entity: "note", uid: ulid(), item_uid: uid, data: { kind: "ticket-request", text: request, ts: now() } }]);
  return uid;
}
async function status(who: string, uid: string, to: string, via = "human") {
  const [row] = await d.query("select versions from items where uid = $1", [uid]);
  await run(who, [{ op: "set", entity: "item", uid, item_uid: uid, data: { status: to }, base: { status: row.versions.status }, via: via as any }]);
}
const child = (who: string, entity: Op["entity"], item_uid: string, data: Record<string, unknown>) =>
  run(who, [{ op: "create", entity, uid: ulid(), item_uid, data: { ts: now(), ...data } }]);

const login = await item("pat", "Safari login fails after password reset", { type: "bug", priority: "high", status: "requested", developer: "dev", qa_assignee: "qa" },
  "Users on Safari 16 get bounced back to the login page after resetting their password.\n\n- Reset password\n- Log in with the new one\n- Lands on /login again");
await status("dev", login, "in-triage");
await child("dev", "note", login, { kind: "clarification", text: "Does this affect Safari 17 too, or only 16?", meta: { state: "open" } });

const exportCsv = await item("pat", "Export invoices as CSV", { priority: "medium", status: "requested", developer: "dev", qa_assignee: "qa" }, "Finance wants a CSV export of the invoice list, filtered the same way as the screen.");
for (const s of ["in-triage", "todo", "in-progress"]) await status("dev", exportCsv, s);
for (const [t, ph, st] of [["query builder", 1, "done"], ["CSV writer", 1, "done"], ["download button", 2, "in-progress"], ["filters parity", 2, "todo"]] as const)
  await child("dev", "task", exportCsv, { title: t, phase: ph, status: st });
await child("dev", "note", exportCsv, { kind: "context", text: "**Stream the CSV** — some tenants have 200k invoices; buffering blew the 1 GB function limit." });
await child("dev", "log", exportCsv, { text: "tried papaparse; switched to a hand-rolled writer for streaming" });
await status("dev", exportCsv, "review", "agent");

const banner = await item("pat", "Maintenance banner", { priority: "low", status: "requested", developer: "dev", qa_assignee: "qa" }, "Show a dismissable banner before scheduled maintenance.");
for (const s of ["in-triage", "todo", "in-progress", "review", "ready-for-qa"]) await status("dev", banner, s);
await child("dev", "note", banner, { kind: "link", text: "Preview", meta: { url: "https://example.com/preview/banner", label: "Preview", type: "preview" } });
await child("dev", "note", banner, { kind: "link", text: "PR #42", meta: { url: "https://example.com/pr/42", label: "PR #42", type: "pr" } });

const tz = await item("pat", "Store times in UTC", { priority: "medium", status: "requested", developer: "dev", qa_assignee: "qa" }, "Times shift by an hour after DST.");
for (const s of ["in-triage", "todo", "in-progress", "review", "ready-for-qa", "in-qa", "ready-to-deploy"]) await status(s === "in-qa" || s === "ready-to-deploy" ? "qa" : "dev", tz, s);
await child("dev", "check", tz, { kind: "db-script", title: "convert timestamps", payload: "db/2026-10-02-utc.sql" });
await child("dev", "check", tz, { kind: "env-var", title: "set TZ", payload: "TZ=UTC" });
await child("dev", "check", tz, { kind: "manual-step", title: "spot-check reports", timing: "post-deploy" });

console.log(JSON.stringify(tokens));
await d.close?.();
process.exit(0);
