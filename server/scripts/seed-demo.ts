// Demo data for trying the dashboard locally: a team of twelve, about seventy
// items in `web` spread over every status, and a small `ops` project with no
// deploy step. The output is the same on every run, and the demo tokens are
// fixed (`<handle>-test`); never use them for real data.
import { applyOps, type Op } from "../lib/apply";
import { addProject, addUser } from "../lib/auth";
import { db } from "../lib/db";
import { ulid } from "../lib/ulid";

const d = await db();
for (const key of ["web", "ops"]) {
  const [{ n }] = await d.query("select count(*)::int as n from items where project = $1", [key]);
  if (Number(n) > 0) {
    console.error(`project ${key} already has items; seed a fresh database`);
    process.exit(1);
  }
}

const PEOPLE: Record<string, string> = {
  pat: "Pat (PM)", priya: "Priya (PM)", morgan: "Morgan (PM)",
  dev: "Dana (dev)", eli: "Eli (dev)", sam: "Sam (dev)", noor: "Noor (dev)", kai: "Kai (dev)", lee: "Lee (dev)",
  qa: "Quinn (QA)", rio: "Rio (QA)", tess: "Tess (QA)",
};
const PMS = ["pat", "priya", "morgan"];
const DEVS = ["dev", "eli", "sam", "noor", "kai", "lee"];
const QAS = ["qa", "rio", "tess"];
const tokens: Record<string, string> = {};
for (const [h, name] of Object.entries(PEOPLE)) tokens[h] = await addUser(d, h, name, `${h}-test`);
await addProject(d, "web", "Web app");
await addProject(d, "ops", "Ops");
await d.query("update projects set deploy_step = false where key = 'ops'");

// mulberry32: a fixed seed keeps screenshots reproducible.
let state = 0x5eed;
const rand = () => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
const chance = (p: number) => rand() < p;

const now = () => new Date().toISOString();
async function run(project: string, who: string, ops: Partial<Op>[], via: "human" | "agent" = "human") {
  return applyOps(d, project, ops.map((o) => ({ op_id: ulid(), via, ...o }) as Op), { handle: who });
}

interface Seeded { uid: string; project: string; creator: string; dev: string; qa: string }

async function item(project: string, title: string, data: Record<string, unknown>, request?: string): Promise<Seeded> {
  const uid = ulid();
  const creator = (data.creator as string) ?? pick(PMS);
  const dev = (data.developer as string) ?? pick(DEVS);
  const qa = (data.qa_assignee as string) ?? pick(QAS);
  await run(project, creator, [{ op: "create", entity: "item", uid, item_uid: uid,
    data: { title, created: now(), status: "requested", creator, developer: dev, qa_assignee: qa, ...data } }]);
  if (request) await child({ uid, project, creator, dev, qa }, creator, "note", { kind: "ticket-request", text: request });
  return { uid, project, creator, dev, qa };
}
async function status(it: Seeded, who: string, to: string, extra: Partial<Op> = {}) {
  const [row] = await d.query("select versions from items where uid = $1 and project = $2", [it.uid, it.project]);
  const [r] = await run(it.project, who, [{ op: "set", entity: "item", uid: it.uid, item_uid: it.uid, data: { status: to },
                                            base: { status: row.versions.status }, ...extra }]);
  if (r.status !== "applied") throw new Error(`${it.uid} → ${to}: ${JSON.stringify(r)}`);
}
const child = (it: Seeded, who: string, entity: Op["entity"], data: Record<string, unknown>, via: "human" | "agent" = "human") =>
  run(it.project, who, [{ op: "create", entity, uid: ulid(), item_uid: it.uid, data: { ts: now(), ...data } }], via);

// ── the scenario items the smoke run walks through ───────────────────────────
const W = { developer: "dev", qa_assignee: "qa", creator: "pat" };
const login = await item("web", "Safari login fails after password reset", { ...W, type: "bug", priority: "high" },
  "Users on Safari 16 get bounced back to the login page after resetting their password.\n\n- Reset password\n- Log in with the new one\n- Lands on /login again");
await status(login, "dev", "in-triage");
await child(login, "dev", "note", { kind: "clarification", text: "Does this affect Safari 17 too, or only 16?", meta: { state: "open" } });

const exportCsv = await item("web", "Export invoices as CSV", { ...W, priority: "medium" }, "Finance wants a CSV export of the invoice list, filtered the same way as the screen.");
for (const s of ["in-triage", "todo", "in-progress"]) await status(exportCsv, "dev", s);
for (const [t, ph, st] of [["query builder", 1, "done"], ["CSV writer", 1, "done"], ["download button", 2, "in-progress"], ["filters parity", 2, "todo"]] as const)
  await child(exportCsv, "dev", "task", { title: t, phase: ph, status: st });
await child(exportCsv, "dev", "note", { kind: "context", text: "**Stream the CSV** — some tenants have 200k invoices; buffering blew the 1 GB function limit." });
await child(exportCsv, "dev", "log", { text: "tried papaparse; switched to a hand-rolled writer for streaming" });
await status(exportCsv, "dev", "review", { via: "agent" });

const banner = await item("web", "Maintenance banner", { ...W, priority: "low" }, "Show a dismissable banner before scheduled maintenance.");
for (const s of ["in-triage", "todo", "in-progress", "review", "ready-for-qa"]) await status(banner, "dev", s);
await child(banner, "dev", "note", { kind: "link", text: "Preview", meta: { url: "https://example.com/preview/banner", label: "Preview", type: "preview" } });
await child(banner, "dev", "note", { kind: "link", text: "PR #42", meta: { url: "https://example.com/pr/42", label: "PR #42", type: "pr" } });

const tz = await item("web", "Store times in UTC", { ...W, priority: "medium" }, "Times shift by an hour after DST.");
for (const s of ["in-triage", "todo", "in-progress", "review", "ready-for-qa", "in-qa", "ready-to-deploy"]) await status(tz, s === "in-qa" || s === "ready-to-deploy" ? "qa" : "dev", s);
await child(tz, "dev", "check", { kind: "db-script", title: "convert timestamps", payload: "db/2026-10-02-utc.sql" });
await child(tz, "dev", "check", { kind: "env-var", title: "set TZ", payload: "TZ=UTC" });
await child(tz, "dev", "check", { kind: "manual-step", title: "spot-check reports", timing: "post-deploy" });

// ── the bulk ─────────────────────────────────────────────────────────────────
const AREAS = ["checkout", "billing", "search", "onboarding", "notifications", "reports", "settings", "admin", "mobile web", "API"];
const WORK: [string, "feature" | "bug" | "refactor"][] = [
  ["Apple Pay at checkout", "feature"], ["Coupon codes stack twice", "bug"], ["Saved carts across devices", "feature"],
  ["Tax rounding off by a cent", "bug"], ["Annual billing toggle", "feature"], ["Prorate seat changes", "feature"],
  ["Invoice PDF missing logo", "bug"], ["Dunning emails", "feature"], ["Typo-tolerant search", "feature"],
  ["Search results flicker on type", "bug"], ["Filter chips for search", "feature"], ["Search index rebuild job", "refactor"],
  ["Onboarding checklist", "feature"], ["Skip onboarding for invited users", "feature"], ["Welcome email sent twice", "bug"],
  ["Sample data for new workspaces", "feature"], ["Digest email for mentions", "feature"], ["Push notifications on mobile web", "feature"],
  ["Unsubscribe link 404s", "bug"], ["Notification preferences page", "feature"], ["Weekly revenue report", "feature"],
  ["Report export times out", "bug"], ["Cohort chart", "feature"], ["Scheduled reports", "feature"],
  ["Dark mode", "feature"], ["Two-factor auth", "feature"], ["Session list with sign-out", "feature"],
  ["Avatar upload rotates photos", "bug"], ["Audit log", "feature"], ["Bulk user import", "feature"],
  ["Role editor", "feature"], ["Admin search is slow", "bug"], ["Bottom nav on mobile", "feature"],
  ["Pinch zoom breaks charts", "bug"], ["Offline banner", "feature"], ["Rate limit headers", "feature"],
  ["Webhooks retry with backoff", "feature"], ["API keys per project", "feature"], ["Pagination cursor drift", "bug"],
  ["Move jobs to the queue service", "refactor"], ["Drop the legacy auth table", "refactor"], ["Split the settings bundle", "refactor"],
  ["Upgrade the date library", "refactor"], ["Retry flaky payment webhook", "bug"], ["Gift cards", "feature"],
  ["Address autocomplete", "feature"], ["Order history filters", "feature"], ["Refund flow for partial orders", "feature"],
  ["CSV import for products", "feature"], ["Image CDN for product photos", "refactor"], ["Wishlist", "feature"],
  ["Low-stock alerts", "feature"], ["Shipping estimate wrong for Alaska", "bug"], ["Guest checkout", "feature"],
  ["Accessibility pass on forms", "refactor"], ["Keyboard shortcuts", "feature"], ["Locale-aware number formats", "feature"],
  ["Customer notes on orders", "feature"], ["Merge duplicate customers", "feature"], ["Status page link in footer", "feature"],
  ["Slow first paint on dashboard", "bug"], ["Remove jQuery", "refactor"], ["SSO with Okta", "feature"],
  ["Team invites expire", "feature"], ["Usage-based pricing meter", "feature"], ["Email templates editor", "feature"],
];

// Shipped is the largest pile; the rest spread over the lifecycle.
const TARGETS: [string, number][] = [
  ["deployed", 16], ["ready-to-deploy", 4], ["in-qa", 5], ["ready-for-qa", 4], ["review", 5], ["in-progress", 9],
  ["todo", 6], ["in-triage", 3], ["requested", 5], ["blocked", 3], ["deferred", 2], ["cancelled", 2],
];
const PATH = ["requested", "in-triage", "todo", "in-progress", "review", "ready-for-qa", "in-qa", "ready-to-deploy", "deployed"];
const mover = (it: Seeded, to: string) => (["in-qa", "ready-to-deploy"].includes(to) ? it.qa : to === "deployed" ? it.dev : it.dev);

const TASKS = ["schema change", "API endpoint", "UI", "tests", "copy review", "feature flag", "analytics events", "docs", "migration", "edge cases"];
const COMMENTS = [
  "Looks good from my side — @%qa can you double-check on Safari?",
  "Design said the empty state should match the reports page.",
  "@%dev the staging data is stale, reseed before testing.",
  "Customer on the enterprise plan asked about this again today.",
  "Pairing with @%dev on this tomorrow morning.",
];
const LOGS = ["first pass compiles; tests red on the timezone case", "swapped the ORM call for a raw query, 4× faster",
              "flaky test was the clock; froze it", "split the PR in two for review", "rebased on main after the auth change"];

async function walk(it: Seeded, to: string, opts: { bounce?: boolean } = {}) {
  const end = PATH.indexOf(to);
  for (let i = 1; i <= end; i++) {
    const s = PATH[i];
    await status(it, mover(it, s), s);
    if (s === "in-qa" && opts.bounce && i < end) {
      await run(it.project, it.qa, [
        { op: "set", entity: "item", uid: it.uid, item_uid: it.uid, data: { status: "in-progress" },
          base: { status: (await d.query("select versions from items where uid = $1 and project = $2", [it.uid, it.project]))[0].versions.status }, group: `b${it.uid}` },
        { op: "create", entity: "note", uid: ulid(), item_uid: it.uid, group: `b${it.uid}`,
          data: { kind: "qa-rejection", text: `Fails on mobile web: the ${pick(["button", "modal", "table", "form"])} overflows. @${it.dev}`, meta: { with_status: "in-progress" } } },
      ]);
      for (const s2 of ["review", "ready-for-qa", "in-qa"]) await status(it, mover(it, s2), s2);
    }
  }
}

async function flesh(it: Seeded, to: string) {
  const at = PATH.indexOf(to);
  const started = at >= PATH.indexOf("in-progress") || ["blocked"].includes(to);
  if (started) {
    const n = 2 + Math.floor(rand() * 5);
    const shipped = at >= PATH.indexOf("review");
    for (let i = 0; i < n; i++) {
      const phase = i < n / 2 ? 1 : 2;
      const st = shipped ? "done" : phase === 1 ? pick(["done", "done", "in-progress"]) : pick(["todo", "todo", "in-progress", "blocked"]);
      await child(it, it.dev, "task", { title: TASKS[(i * 3 + it.uid.charCodeAt(25)) % TASKS.length], phase, status: st }, chance(0.3) ? "agent" : "human");
    }
    if (chance(0.7)) await child(it, it.dev, "log", { text: pick(LOGS) }, chance(0.4) ? "agent" : "human");
    if (chance(0.5)) await child(it, it.dev, "note", { kind: "context", text: `**${pick(["Keep the old endpoint", "Behind a flag", "Cache per tenant", "No schema change needed"])}** — ${pick(["mobile clients pin the v1 path.", "rollout starts with internal users.", "the shared cache leaked between tenants.", "the column already exists."])}` });
  }
  if (at >= PATH.indexOf("review")) {
    const pr = 100 + Math.floor(rand() * 900);
    await child(it, it.dev, "note", { kind: "link", text: `PR #${pr}`, meta: { url: `https://example.com/pr/${pr}`, label: `PR #${pr}`, type: "pr" } });
    if (chance(0.5)) await child(it, it.dev, "note", { kind: "link", text: "Preview", meta: { url: `https://example.com/preview/${pr}`, label: "Preview", type: "preview" } });
  }
  if (chance(0.45)) await child(it, pick([it.creator, it.dev, it.qa]), "note", { kind: "comment", text: pick(COMMENTS).replace("%qa", it.qa).replace("%dev", it.dev) });
  if (at >= 1 && chance(0.25)) {
    const answered = chance(0.6);
    await child(it, it.dev, "note", { kind: "clarification", text: pick(["Should this apply to archived records too?", "Is the old behaviour relied on by the mobile app?", "What should happen for guests?"]),
      meta: answered ? { state: "answered", answer: pick(["Yes, everything.", "No — mobile is on v2 now.", "Treat them like a free plan."]), answered_by: it.creator } : { state: "open" } });
  }
}

let w = 0;
let k = 0;
for (const [to, count] of TARGETS) {
  for (let i = 0; i < count; i++, w++) {
    const [title, type] = WORK[w % WORK.length];
    const area = AREAS[(w * 7) % AREAS.length];
    const it = await item("web", title, { type, priority: pick(["low", "medium", "medium", "medium", "high", "high", "urgent"]) },
      `${type === "bug" ? "Broken" : "Wanted"} in ${area}: ${title.toLowerCase()}.\n\n${type === "bug" ? "Steps:\n\n- open " + area + "\n- try it\n- see it fail" : "Why: customers keep asking in support tickets."}`);
    k++;
    const bounce = ["deployed", "ready-to-deploy", "in-qa"].includes(to) && k % 4 === 0;
    if (to === "blocked") { await walk(it, "in-progress"); await flesh(it, "in-progress"); await status(it, it.dev, "blocked"); await child(it, it.dev, "note", { kind: "comment", text: `Blocked on the ${pick(["payments vendor", "design review", "infra ticket"])}. @${it.creator}` }); continue; }
    if (to === "deferred") { await walk(it, "todo"); await status(it, it.creator, "deferred"); continue; }
    if (to === "cancelled") { await walk(it, "in-triage"); await status(it, it.creator, "cancelled"); continue; }
    if (to === "ready-to-deploy" || to === "deployed") {
      await walk(it, "in-progress");
      await flesh(it, to);
      if (chance(0.7)) await child(it, it.dev, "check", { kind: "db-script", title: "run migration", payload: `db/2026-09-${10 + (w % 20)}-${area.replace(/\s/g, "-")}.sql` });
      if (chance(0.5)) await child(it, it.dev, "check", { kind: "env-var", title: "set flag", payload: `${area.toUpperCase().replace(/\s/g, "_")}_V2=1` });
      if (chance(0.4)) await child(it, it.dev, "check", { kind: "manual-step", title: "announce in #releases", timing: "post-deploy" });
      for (const s of PATH.slice(PATH.indexOf("review"), PATH.indexOf("ready-to-deploy") + 1)) {
        await status(it, mover(it, s), s);
        if (s === "in-qa" && bounce) {
          await run("web", it.qa, [
            { op: "set", entity: "item", uid: it.uid, item_uid: it.uid, data: { status: "in-progress" }, group: `b${it.uid}`,
              base: { status: (await d.query("select versions from items where uid = $1 and project = 'web'", [it.uid]))[0].versions.status } },
            { op: "create", entity: "note", uid: ulid(), item_uid: it.uid, group: `b${it.uid}`, data: { kind: "qa-rejection", text: `Totals are wrong for multi-currency carts. @${it.dev}`, meta: { with_status: "in-progress" } } },
          ]);
          for (const s2 of ["review", "ready-for-qa", "in-qa"]) await status(it, mover(it, s2), s2);
        }
      }
      if (to === "deployed") {
        const checks = await d.query("select uid, versions from checks where item_uid = $1 and project = 'web' and timing = 'pre-deploy'", [it.uid]);
        for (const c of checks) await run("web", it.dev, [{ op: "set", entity: "check", uid: c.uid, item_uid: it.uid, data: { status: "done" }, base: { status: c.versions.status } }]);
        await status(it, it.dev, "deployed");
      }
      continue;
    }
    await walk(it, to, { bounce });
    await flesh(it, to);
  }
}

// Request versions: a change that went back to triage and was re-triaged, a
// change waiting in `requested`, and one worked on without triage.
async function newVersion(it: Seeded, text: string) {
  await child(it, it.creator, "note", { kind: "ticket-request", text });
}
const pickItem = async (st: string, skip = 0) => {
  const rows = await d.query("select uid, creator, developer, qa_assignee from items where project = 'web' and status = $1 order by created, uid", [st]);
  const r = rows[skip];
  return { uid: r.uid, project: "web", creator: r.creator, dev: r.developer, qa: r.qa_assignee } as Seeded;
};
const retriaged = await pickItem("in-progress", 1);
const [cur1] = await d.query("select text from notes where item_uid = $1 and kind = 'ticket-request'", [retriaged.uid]);
await newVersion(retriaged, `${cur1.text}\n\nAlso: keep the old behaviour behind a setting for enterprise tenants.`);
for (const s of ["in-triage", "todo", "in-progress"]) await status(retriaged, retriaged.dev, s);

const waiting = await pickItem("todo", 1);
const [cur2] = await d.query("select text from notes where item_uid = $1 and kind = 'ticket-request'", [waiting.uid]);
await newVersion(waiting, cur2.text.replace("customers keep asking", "three enterprise customers asked this week"));

const untriaged = await pickItem("in-progress", 2);
const [cur3] = await d.query("select text from notes where item_uid = $1 and kind = 'ticket-request'", [untriaged.uid]);
await newVersion(untriaged, `${cur3.text}\n\nScope change: include the mobile web layout.`);
await status(untriaged, untriaged.dev, "in-progress");          // straight back to work, skipping triage

// An override, so history shows one.
const hot = await pickItem("todo", 2);
await status(hot, "pat", "in-qa", { override: true, reason: "hotfix already on staging; QA to verify directly" });

// ── ops: no deploy step ─────────────────────────────────────────────────────
const OPS: [string, string][] = [
  ["Rotate the database credentials", "done"], ["Renew the TLS certificate", "done"], ["Move backups to the new bucket", "in-qa"],
  ["Alert on queue depth", "in-progress"], ["Runbook for failover", "review"], ["Tidy the staging DNS", "todo"],
  ["Cost report for September", "requested"], ["Turn off the old CI runners", "in-triage"],
];
const OPS_PATH = ["requested", "in-triage", "todo", "in-progress", "review", "ready-for-qa", "in-qa", "done"];
for (const [title, to] of OPS) {
  const it = await item("ops", title, { type: "refactor", priority: pick(["low", "medium", "high"]) }, `${title}.`);
  for (const s of OPS_PATH.slice(1, OPS_PATH.indexOf(to) + 1)) await status(it, ["in-qa", "done"].includes(s) ? it.qa : it.dev, s);
  if (OPS_PATH.indexOf(to) >= 3) await child(it, it.dev, "task", { title: "do it", phase: 1, status: to === "in-progress" ? "in-progress" : "done" });
}

// ── spread the timeline over the last 30 days ───────────────────────────────
// Each item starts on a day of its own; its history steps follow in order.
const items = await d.query("select project, uid from items order by created, uid");
const DAY = 86_400_000;
const t0 = Date.now();
for (const [i, it] of items.entries()) {
  const start = t0 - (30 - (i * 29) / items.length) * DAY - (i % 5) * 3_600_000;
  const hist = await d.query("select uid from status_history where project = $1 and item_uid = $2 order by n", [it.project, it.uid]);
  const span = Math.max(t0 - start - DAY / 4, DAY / 4);
  const step = span / (hist.length + 1);
  const at = (n: number) => new Date(start + step * n + (n * 1_234_567) % 3_600_000).toISOString();
  await d.query("update items set created = $3 where project = $1 and uid = $2", [it.project, it.uid, new Date(start).toISOString()]);
  for (const [n, h] of hist.entries()) await d.query("update status_history set ts = $3 where project = $1 and uid = $2", [it.project, h.uid, at(n + 1)]);
  for (const table of ["notes", "logs"]) {
    const rows = await d.query(`select uid from ${table} where project = $1 and item_uid = $2 order by n`, [it.project, it.uid]);
    for (const [n, r] of rows.entries()) await d.query(`update ${table} set ts = $3 where project = $1 and uid = $2`, [it.project, r.uid, at(Math.min(n + 1, hist.length + 1))]);
  }
  await d.query("update items set completed = (select max(ts) from status_history h where h.project = $1 and h.item_uid = $2) where project = $1 and uid = $2 and completed is not null", [it.project, it.uid]);
}

const [{ n }] = await d.query("select count(*)::int as n from items");
console.log(JSON.stringify({ items: Number(n), users: Object.keys(tokens).length, password: "<handle>-test" }));
await d.close?.();
process.exit(0);
