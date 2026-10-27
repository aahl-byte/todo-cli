// UI smoke run against a seeded server:
//   TOKENS=<file with {"pat","dev","qa"} tokens> BASE_URL=http://<host>:<port> SHOTS=<dir> node scripts/smoke.cjs
// Seed with `TODO_PGLITE=<dir> npm run seed:demo`, then start the server on the
// same dir, with the env the README names; no plugin connection comes from the
// environment, since the smoke sets them up on the page. Point BASE_URL at a real hostname rather than localhost:
// browsers treat localhost as secure, which hides cookie problems on plain-http hosts.
const { chromium } = require("playwright");
const fs = require("fs");
const http = require("http");
const os = require("os");

const tokens = process.env.TOKENS ? JSON.parse(fs.readFileSync(process.env.TOKENS, "utf8")) : { pat: "pat-test", dev: "dev-test", qa: "qa-test" };
const base = process.env.BASE_URL || "http://127.0.0.1:10093/todo-demo";
const out = process.env.SHOTS || os.tmpdir();
const errors = [];
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

(async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + "/login"); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  // A Jira site on this machine for the page's jira connection: it lists statuses and answers nothing else.
  const jiraStatuses = ["Open", "In Progress", "In QA", "Ready to deploy", "Done"].map((name) => ({ name }));
  const fakeJira = http.createServer((req, res) => {
    const body = req.url.startsWith("/rest/api/3/project/") ? [{ statuses: jiraStatuses }] : req.url.startsWith("/rest/api/3/status") ? jiraStatuses : null;
    res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? { errorMessages: ["not here"] }));
  });
  await new Promise((r) => fakeJira.listen(0, "127.0.0.1", r));
  const jiraUrl = `http://127.0.0.1:${fakeJira.address().port}`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 200) + " @ " + (m.location()?.url ?? "")); });
  const step = async (name, fn) => {
    try { await fn(); console.log("ok  ", name); }
    catch (e) { console.log("FAIL", name, e.message.split("\n").slice(0, 6).join(" | ")); errors.push(name); }
  };
  const login = async (who, path = "/p/web") => {
    await page.goto("about:blank");
    await ctx.clearCookies();
    await page.goto(base + "/login?next=" + encodeURIComponent(path));
    await page.fill("input[name=handle]", who);
    await page.fill("input[name=token]", tokens[who]);
    await page.click("button.primary");
    await page.waitForURL((u) => u.pathname === path);
    if (!(await ctx.cookies()).some((c) => c.name === "todo_token")) throw new Error("sign-in cookie not stored");
  };
  const item = (id) => base + "/p/web/i/" + id;
  const visibleInputs = () => page.locator("main input:visible, main textarea:visible, main select:visible").count();
  const status = () => page.locator(".head .stat-label").first().textContent();
  const pickStatus = async (s) => {
    await page.click("button[aria-label=status]");
    await page.locator(`.menu li:has(.s-${s})`).first().click();
  };
  const api = (who, ops) => fetch(base + "/api/projects/web/ops", {
    method: "POST", headers: { authorization: "Bearer " + tokens[who], "content-type": "application/json" },
    body: JSON.stringify({ ops }),
  });

  await step("signed-out pages leak nothing", async () => {
    for (const path of ["/p/web", "/p/web/deploy", "/p/web/new", "/p/web/qa", "/inbox", "/p/web/i/store-times-in-utc"]) {
      const res = await fetch(base + path, { redirect: "manual" });
      const body = await res.text();
      if (res.status < 300 || res.status >= 400) throw new Error(`${path}: ${res.status}`);
      if (/convert timestamps|Store times|"dev"|Safari/.test(body)) throw new Error(`${path} leaked data`);
    }
  });
  await step("sign-in refuses an off-site redirect", async () => {
    await page.goto(base + "/login?next=/%09/example.org/x");
    await page.fill("input[name=handle]", "dev");
    await page.fill("input[name=token]", tokens.dev);
    await page.click("button.primary");
    await page.waitForURL((u) => u.host === new URL(base).host && !u.pathname.startsWith("/login"));
  });

  await step("board: columns and filters that apply on click", async () => {
    await login("dev");
    for (const t of ["Open", "Ready", "In progress", "QA", "Ready to deploy"]) await page.getByRole("region", { name: t, exact: true }).waitFor();
    if (await page.getByRole("region", { name: "Triage" }).count()) throw new Error("Triage column still shown");
    await page.click("button:has-text('Mine')");
    await page.waitForURL(/f=dev%3Adev%2Cqa%3Adev%2Cby%3Adev|f=dev:dev,qa:dev,by:dev/);
    await page.waitForURL(/view=merged/);
    await page.click("button:has-text('Mine')");
    await page.waitForURL((u) => !u.search.includes("f="));
    await page.screenshot({ path: out + "/board.png", fullPage: true });
  });

  await step("item: no inputs until asked", async () => {
    await page.goto(item("export-invoices-as-csv"));
    await page.locator(".head").waitFor();
    if (await visibleInputs()) throw new Error(`${await visibleInputs()} inputs on load`);
    await page.screenshot({ path: out + "/item.png", fullPage: true });
  });

  await step("item: title is text until clicked", async () => {
    await page.click(".head .title .edit-text");
    await page.fill(".head .title input", "Export invoices as CSV (streamed)");
    await page.keyboard.press("Enter");
    await page.locator(".head .title .edit-text", { hasText: "(streamed)" }).waitFor();
  });

  await step("item: status menu offers only allowed moves", async () => {
    await page.click("button[aria-label=status]");
    const opts = await page.locator(".menu li .stat-label").allTextContents();
    await page.keyboard.press("Escape");
    const want = ["ready-for-qa", "in-progress", "blocked", "deferred", "cancelled"];
    if (JSON.stringify(opts) !== JSON.stringify(want)) throw new Error(JSON.stringify(opts));
  });

  await step("item: back to work asks for an optional comment", async () => {
    await pickStatus("in-progress");
    await page.locator(".popup textarea").fill("split the PR please");
    await page.locator(".popup button.primary").click();
    await page.waitForFunction(() => document.querySelector(".head .stat-label")?.textContent === "in-progress");
    await page.click("role=tab[name=/Comments/]");
    await page.locator(".entry", { hasText: "split the PR please" }).waitFor();
  });

  await step("item: comments open a composer on demand", async () => {
    await page.click("button.add:has-text('comment')");
    await page.locator(".composer textarea").fill("@qa ready soon");
    await page.click(".composer button.primary");
    await page.locator(".entry", { hasText: "@qa ready soon" }).waitFor();
    if (await page.locator(".composer:visible").count()) throw new Error("composer stayed open");
  });

  await step("item: tasks fold done work; the light picks status", async () => {
    await page.click("role=tab[name=/Tasks/]");
    await page.locator(".tgroup", { hasText: "phase 1" }).waitFor();
    if (await page.locator(".trow", { hasText: "query builder" }).count()) throw new Error("done task not folded");
    const row = page.locator(".trow", { hasText: "filters parity" });
    await row.locator(".dotbtn").click();
    await page.locator(".menu li:has(.s-done)").click();
    await page.waitForFunction(() => [...document.querySelectorAll(".trow")].every((r) => !r.textContent.includes("filters parity")) ||
      document.querySelector(".trow.s-done") !== null);
    await page.click("button:has-text('show done')");
    await page.locator(".trow", { hasText: "query builder" }).waitFor();
    await page.click("button.add:has-text('task')");
    await page.locator(".composer textarea").fill("write docs");
    await page.click(".composer button.primary");
    await page.locator(".trow", { hasText: "write docs" }).waitFor();
  });

  await step("item: notes and log collapse to one line and expand", async () => {
    await page.click("role=tab[name=/Notes/]");
    const first = page.locator(".entry .first").first();
    await first.waitFor();
    await first.click();
    await page.locator(".entry .md strong", { hasText: "Stream the CSV" }).waitFor();
    await page.click("role=tab[name=/Log/]");
    await page.locator(".entry .stamp").first().waitFor();
    await page.click("button.add:has-text('log')");
    await page.locator(".composer textarea").fill("switched to streaming writer");
    await page.click(".composer button.primary");
    await page.locator(".entry", { hasText: "switched to streaming writer" }).waitFor();
  });

  await step("item: links and checks add through popups and remove", async () => {
    await page.click(".wide-only button[aria-label='add link']");
    await page.fill(".popup input[aria-label=URL]", "https://example.com/pr/7");
    await page.fill(".popup input[aria-label=label]", "PR #7");
    await page.click(".popup button.primary");
    await page.locator(".wide-only a", { hasText: "PR #7" }).waitFor();
    await page.click(".wide-only button[aria-label='add check']");
    await page.fill(".popup input[aria-label=title]", "run migration");
    await page.click(".popup button.primary");
    const check = page.locator(".wide-only .rrow", { hasText: "run migration" });
    await check.waitFor();
    await check.locator("input[type=checkbox]").check();
    await page.waitForFunction(() => [...document.querySelectorAll(".wide-only .rrow")].every((r) => !r.textContent.includes("run migration") || r.querySelector("input:checked")));
    const link = page.locator(".wide-only .rrow", { hasText: "PR #7" });
    await link.hover();
    await link.locator("button[aria-label=remove]").click();
    await link.locator("button.armed").click();
    await page.locator(".wide-only a", { hasText: "PR #7" }).waitFor({ state: "detached" });
  });

  await step("popups keep the cursor where you type", async () => {
    await page.click(".wide-only button[aria-label='add link']");
    await page.fill(".popup input[aria-label=URL]", "https://example.com/x");
    await page.click(".popup input[aria-label=label]");
    await page.keyboard.type("Hello");
    const url = await page.inputValue(".popup input[aria-label=URL]");
    const label = await page.inputValue(".popup input[aria-label=label]");
    await page.keyboard.press("Escape");
    if (url !== "https://example.com/x" || label !== "Hello") throw new Error(`${url} / ${label}`);
  });

  await step("note actions show on hover", async () => {
    await page.click("role=tab[name=/Notes/]");
    const row = page.locator(".entry").first();
    await row.hover();
    const op = await row.locator(".x").first().evaluate((el) => getComputedStyle(el).opacity);
    if (op !== "1") throw new Error("opacity " + op);
  });

  await step("item: history shows a light and a time per entry", async () => {
    const rows = page.locator(".wide-only .hist .rrow");
    if ((await rows.count()) < 2) throw new Error("no history");
    if (await rows.first().locator(".ago").count() !== 1) throw new Error("no time");
  });

  await step("request: a frozen version takes a new one and goes back to requested", async () => {
    await page.goto(item("safari-login-fails-after-password-reset"));
    await page.click("button.add:has-text('new version')");
    await page.fill(".popup input[aria-label=URL]", "https://example.com/reset");
    await page.fill(".popup textarea", "Safari 16 and 17 bounce back to /login after a password reset.");
    await page.click(".popup button.primary");
    await page.waitForFunction(() => document.querySelector(".head .stat-label")?.textContent === "requested");
    await page.locator(".req-diff .add-l", { hasText: "URL: https://example.com/reset" }).waitFor();
    await page.click(".request button:has-text('show as text')");
    await page.locator(".request a.req-url", { hasText: "example.com/reset" }).waitFor();
    await page.click(".request button:has-text('show changes')");
    await page.click(".request button:has-text('versions')");
    await page.locator(".version .tgroup").first().click();
    await page.locator(".versions .diff .add-l", { hasText: "16 and 17" }).waitFor();
    await page.locator(".versions .diff .del-l").first().waitFor();
    await page.screenshot({ path: out + "/request-versions.png", fullPage: true });
  });

  await step("request: editable in place while requested", async () => {
    await page.click("button.add:has-text('edit')");
    await page.fill(".request textarea", "Safari 16 and 17 bounce back to /login after a password reset. Chrome is fine.");
    await page.click(".request button.primary");
    await page.locator(".request", { hasText: "Chrome is fine" }).waitFor();
  });

  await step("request: a refused edit keeps the draft and offers a new version", async () => {
    await page.click("button.add:has-text('edit')");
    await page.fill(".request textarea", "my draft");
    const v = await (await fetch(base + "/api/projects/web/changes?since=0&limit=5000", { headers: { authorization: "Bearer " + tokens.pat } })).json();
    const it = v.changes.filter((c) => c.entity === "item" && c.data && c.data.id === "safari-login-fails-after-password-reset").pop();
    await api("dev", [{ op_id: "tri-" + Date.now(), op: "set", entity: "item", uid: it.uid, item_uid: it.uid, data: { status: "in-triage" }, base: { status: it.data.versions.status } }]);
    await page.click(".request button.primary");
    await page.locator(".request button:has-text('Save as v3')").waitFor();
    if ((await page.inputValue(".request textarea")) !== "my draft") throw new Error("draft lost");
    await page.keyboard.press("Escape");
  });

  await step("override: other… needs a reason and is marked in history", async () => {
    await page.goto(item("keyboard-shortcuts"));
    await page.click("button[aria-label=status]");
    await page.locator(".menu li", { hasText: "other…" }).click();
    if (await page.locator(".popup button.danger").isEnabled()) throw new Error("override without a reason allowed");
    await page.selectOption(".popup select", "in-progress");
    await page.fill(".popup textarea", "already built during the spike");
    await page.click(".popup button.danger");
    await page.waitForFunction(() => document.querySelector(".head .stat-label")?.textContent === "in-progress");
    await page.locator(".wide-only .hist .tag", { hasText: "override" }).waitFor();
  });

  await step("rail: app and section, related items, glance opens tasks", async () => {
    await page.goto(item("export-invoices-as-csv"));
    await page.locator(".wide-only .kv button.edit-text").first().click();
    await page.fill(".popup input[aria-label=app]", "billing");
    await page.fill(".popup input[aria-label=section]", "invoices");
    await page.click(".popup button.primary");
    await page.locator(".wide-only .kv", { hasText: "invoices" }).waitFor();
    await page.click(".wide-only button[aria-label='relate an item']");
    await page.fill(".popup input[aria-label='find an item']", "Maintenance");
    await page.locator(".popup .pick", { hasText: "Maintenance banner" }).click();
    await page.locator(".wide-only .rrow a", { hasText: "Maintenance banner" }).waitFor();
    await page.click(".wide-only .glance-block");
    await page.locator("role=tab[name=/Tasks/][selected=true]").waitFor();
    await page.screenshot({ path: out + "/item-rail.png", fullPage: true });
    await page.goto(item("maintenance-banner"));
    await page.locator(".wide-only .rrow a", { hasText: "Export invoices" }).waitFor();
  });

  await step("tasks: a phase takes a title", async () => {
    await page.goto(item("export-invoices-as-csv"));
    await page.click("role=tab[name=/Tasks/]");
    const row = page.locator(".tgroup-row", { hasText: "phase 2" });
    await row.hover();
    await row.locator(".phase-title button").click();
    await row.locator(".phase-title input").fill("UI");
    await page.keyboard.press("Enter");
    await page.locator(".tgroup-row .phase-title", { hasText: "UI" }).waitFor();
  });

  await step("a stale write shows a notice and keeps the page", async () => {
    const p2 = await ctx.newPage();
    await p2.route("**/api/projects/*/changes*", (r) => r.abort());
    await p2.goto(item("maintenance-banner"));
    await page.goto(item("maintenance-banner"));
    await pickStatus("in-qa");
    await page.waitForFunction(() => document.querySelector(".head .stat-label")?.textContent === "in-qa");
    await p2.click("button[aria-label=status]");
    await p2.locator(".menu li:has(.s-blocked)").click();
    await p2.fill(".popup textarea", "waiting on the API");
    await p2.locator(".popup button.primary").click();
    await p2.locator(".toasts .toast").waitFor();
    console.log("     notice:", (await p2.locator(".toasts .toast span").first().textContent()));
    await p2.close();
  });

  await step("a refused title save keeps the draft", async () => {
    const p3 = await ctx.newPage();
    await p3.route("**/api/projects/*/changes*", (r) => r.abort());
    await p3.goto(item("safari-login-fails-after-password-reset"));
    await p3.click(".head .title .edit-text");
    const uid = await p3.locator("[data-uid]").first().getAttribute("data-uid");
    const v = await (await fetch(base + "/api/projects/web/changes?since=0&limit=2000", { headers: { authorization: "Bearer " + tokens.pat } })).json();
    const row = v.changes.find((c) => c.uid === uid);
    await api("pat", [{ op_id: "t-" + Date.now(), op: "set", entity: "item", uid, item_uid: uid, data: { title: "Renamed by Pat" }, base: { title: row.data.versions.title } }]);
    await p3.fill(".head .title input", "My draft");
    await p3.keyboard.press("Enter");
    await p3.locator(".toasts .toast").waitFor();
    if ((await p3.inputValue(".head .title input")) !== "My draft") throw new Error("draft lost");
    await p3.close();
  });

  await step("QA: reject needs a comment", async () => {
    await login("qa", "/p/web/qa");
    await page.screenshot({ path: out + "/qa.png", fullPage: true });
    const cards = await page.locator(".qa-page > .cards .qa-card").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
    if (cards.length > 1 && new Set(cards.map(Math.round)).size === cards.length) throw new Error("QA cards don't share rows");
    const row = page.locator(".qa-page > .cards .qa-card", { hasText: "Maintenance banner" });
    await row.locator("button:has-text('Reject')").click();
    if (await page.locator(".popup button.danger").isEnabled()) throw new Error("reject without a comment allowed");
    await page.fill(".popup textarea", "Banner overlaps the nav on mobile");
    await page.click(".popup button.danger");
    await page.locator(".qa-page > .cards .qa-card", { hasText: "Maintenance banner" }).waitFor({ state: "detached" });
    await page.locator(".awaiting summary", { hasText: "Awaiting fix" }).click();
    await page.locator(".awaiting .qa-card", { hasText: "Maintenance banner" }).waitFor();
  });

  await step("deploy: pending checks need a confirmed force", async () => {
    await page.goto(base + "/p/web/deploy");
    await page.screenshot({ path: out + "/deploy.png", fullPage: true });
    const ticket = page.locator(".ticket", { hasText: "Store times in UTC" });
    await ticket.locator(".check-row", { hasText: "convert timestamps" }).waitFor();
    await ticket.locator("button:has-text('Mark deployed')").click();
    await page.locator(".popup button.danger", { hasText: "Deploy anyway" }).click();
    await page.locator(".label.section", { hasText: "Deployed · still to do" }).waitFor();
    if (await page.locator("button:has-text('Deploy all')").count()) throw new Error("Deploy all still shown");
    await page.locator(".ticket", { hasText: "Store times in UTC" }).locator("button:has-text('Mark deployed')").waitFor({ state: "detached" });
  });

  await step("dev: the rejection waits in qa-rejected, highlighted, and opening it clears the notice", async () => {
    await login("dev", "/inbox");
    await page.screenshot({ path: out + "/inbox.png", fullPage: true });
    const box = page.locator(".ibox", { hasText: "Maintenance banner" });
    await box.locator(".notice .kind.hot").first().waitFor();
    const count = async () => Number((await page.locator(".topbar .count").first().textContent().catch(() => "0")) || 0);
    await page.waitForFunction(() => document.querySelector(".topbar .count"));
    const before = await count();
    await box.locator("header a.title").click();
    await page.waitForURL(/maintenance-banner/);
    await page.waitForFunction(() => document.querySelector(".head .stat-label")?.textContent === "qa-rejected");
    await page.click("role=tab[name=/Comments/]");
    await page.locator(".entry.is-new", { hasText: "Banner overlaps" }).waitFor();
    await page.waitForFunction((b) => Number(document.querySelector(".topbar .count")?.textContent || 0) < b, before);
    await page.screenshot({ path: out + "/item-new.png", fullPage: true });
    await page.click("button[aria-label=status]");
    const opts = await page.locator(".menu li .stat-label").allTextContents();
    await page.keyboard.press("Escape");
    if (opts[0] !== "in-progress" || !opts.includes("in-triage")) throw new Error(JSON.stringify(opts));
  });

  await step("inbox: clear a ticket, mark all read, undo", async () => {
    await page.goto(base + "/inbox");
    const first = page.locator(".ibox").first();
    const title = await first.locator("header a.title").textContent();
    await first.locator("button.clear").click();
    await page.locator(".ibox", { hasText: title }).waitFor({ state: "detached" });
    await page.click("button:has-text('Mark all read')");
    await page.waitForFunction(() => !document.querySelector("a.notice.unread"));
    await page.click(".toast button:has-text('Undo')");
    await page.locator("a.notice.unread").first().waitFor();
    const row = page.locator("a.notice.unread").first();
    await row.click();
    await page.waitForURL(/\/p\/web\/i\//);
  });

  await step("filters: role entries merged and as tabs, on the board and the QA queue", async () => {
    await page.goto(base + "/p/web?mine=1");
    await page.waitForURL(/f=/);
    await page.goto(base + "/p/web");
    await page.click("summary:has-text('Filter')");
    await page.click(".role-filter button.add");
    await page.waitForURL(/f=/);
    await page.click(".role-filter button.add");
    await page.waitForFunction(() => document.querySelectorAll(".role-filter .entry-row").length === 2);
    for (const w of await page.locator(".role-filter .entry-row select").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width))) {
      if (w < 80) throw new Error(`filter dropdown only ${w}px wide`);
    }
    const rows = await page.locator(".role-filter .entry-row").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    if (rows.some((h) => h > 40)) throw new Error(`filter row wraps: ${rows.join(", ")}px tall`);
    await page.screenshot({ path: out + "/filter-menu.png" });
    await page.keyboard.press("Escape");
    await page.locator(".role-tabs [role=tab]").nth(1).click();
    await page.waitForURL(/tab=1/);
    await page.screenshot({ path: out + "/board-tabs.png", fullPage: true });
    await page.click(".seg button:has-text('merged')");
    await page.waitForURL(/view=merged/);
    if ((await page.locator(".filters .chip").count()) !== 2) throw new Error("no chips in merged view");
    await page.click(".seg button:has-text('tabs')");
    await page.waitForURL((u) => !u.search.includes("view="));
    await page.click(".topbar nav a:has-text('QA')");
    await page.waitForURL((u) => u.pathname === "/p/web/qa" && u.search.includes("f="));
    await page.goto(base + "/p/web/qa?f=qa:qa,qa:rio");
    await page.locator(".role-tabs [role=tab]", { hasText: "qa by rio" }).waitFor();
    await page.goto(base + "/p/web/qa");
    const labels = await page.locator(".qa-page > .label").allTextContents();
    const iq = labels.findIndex((t) => t.startsWith("In QA")), rq = labels.findIndex((t) => t.startsWith("Ready for QA"));
    if (iq < 0 || rq < 0 || iq > rq) throw new Error(`QA sections out of order: ${labels.join(" / ")}`);
    await page.goto(base + "/p/web/deploy?f=dev:kai");
    await page.locator(".ticket", { hasText: "Push notifications on mobile web" }).waitFor();
    if (await page.locator(".ticket", { hasText: "Digest email for mentions" }).count()) throw new Error("deploy filter shows another developer's ticket");
    await page.goto(base + "/p/web/deploy?f=dev:nobody-here");
    await page.locator(".filters").waitFor();
    await page.locator("p.empty").waitFor();
    await page.screenshot({ path: out + "/qa.png", fullPage: true });
  });

  await step("filters: remembered through navigation until cleared", async () => {
    await login("dev");
    await page.click("button:has-text('Mine')");
    await page.waitForURL(/f=/);
    await page.locator(".board .card").first().click();
    await page.waitForURL(/\/i\//);
    await page.click(".topbar nav a:has-text('Board')");
    await page.waitForURL((u) => u.pathname === "/p/web" && u.search.includes("f="));
    await page.goto(base + "/p/web");
    await page.waitForURL((u) => u.search.includes("f="));
    await page.goto(base + "/p/web/deploy");
    await page.waitForURL((u) => u.search.includes("f="));
    await page.goto(base + "/p/web");
    await page.click("button:has-text('Mine')");
    await page.waitForURL((u) => !u.search.includes("f="));
    await page.goto(base + "/p/web");
    await page.waitForLoadState("networkidle");
    if (new URL(page.url()).search.includes("f=")) throw new Error("cleared filter came back");
  });

  await step("new request with app, section, URL and a dropped image", async () => {
    await login("pat", "/p/web/new");
    await page.fill("input[name=title]", "Dark mode for reports");
    await page.fill("input[name=app]", "storefront");
    await page.fill("input[name=section]", "reports");
    await page.fill("input[name=url]", "https://example.com/reports");
    await page.fill("textarea[name=description]", "Reports are unreadable at night.");
    await page.evaluate(async (png) => {
      const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], "night.png", { type: "image/png" }));
      const ta = document.querySelector("textarea[name=description]");
      ta.selectionStart = ta.selectionEnd = ta.value.length;
      ta.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, PNG);
    await page.waitForFunction(() => /\/api\/files\/web\/new\/\w+\.png/.test(document.querySelector("textarea[name=description]").value));
    await page.click("button:has-text('Submit')");
    await page.waitForURL(/\/i\/dark-mode-for-reports/);
    await page.locator(".request", { hasText: "unreadable at night" }).waitFor();
    await page.locator(".request a.req-url").waitFor();
    await page.waitForFunction(() => { const i = document.querySelector(".request img"); return i && i.complete && i.naturalWidth > 0; });
    await page.locator(".wide-only .kv", { hasText: "reports" }).waitFor();
  });

  await step("live refresh picks up another user's change", async () => {
    await page.goto(base + "/p/web");
    const res = await api("dev", [{ op_id: "smoke-" + Date.now(), op: "create", entity: "item", uid: "SMOKE" + Date.now(), item_uid: "x",
      data: { title: "Created by the API", created: new Date().toISOString() } }]);
    if (!res.ok) throw new Error("push " + res.status);
    await page.getByText("Created by the API").waitFor({ timeout: 10000 });
  });

  await step("settings: linked from the nav; shows the Jira triggers", async () => {
    await page.goto(base + "/p/web");
    await page.locator("nav").getByRole("link", { name: "Settings" }).click();
    await page.waitForURL(/\/p\/web\/settings$/);
    await page.locator(".settings-head", { hasText: "Linked issues" }).waitFor({ timeout: 5000 });
  });

  await step("a question takes a follow-up reply in its thread", async () => {
    await page.goto(item("export-invoices-as-csv"));
    await page.click("role=tab[name=/Questions/]");
    await page.click("button.add:has-text('ask')");
    await page.fill(".composer textarea", "Smoke: which format?");
    await page.click(".composer button.primary");
    const thread = page.locator(".thread", { hasText: "Smoke: which format?" });
    await thread.locator("button.add:has-text('answer')").click();
    await thread.locator("textarea[aria-label=answer]").fill("CSV");
    await thread.locator("button.primary:has-text('Answer')").click();
    await thread.locator(".qa-a", { hasText: "CSV" }).waitFor();
    await thread.locator("button.add:has-text('follow up')").click();
    await thread.locator("textarea[aria-label='follow up']").fill("Smoke: use semicolons");
    await thread.locator("button:has-text('Reply')").click();
    await thread.locator(".turn.follow .qa-r", { hasText: "use semicolons" }).waitFor();
    await page.click("role=tab[name=/Comments/]");
    if (await page.locator(".entries", { hasText: "use semicolons" }).count()) throw new Error("thread reply also listed with the comments");
  });

  await step("the id copies over plain http", async () => {
    await page.goto(item("export-invoices-as-csv"));
    await page.click(".wide-only .mono-id");
    await page.locator(".wide-only .mono-id .copied-mark").waitFor();
  });

  await step("a Watchtower file link opens the file in Watchtower", async () => {
    await page.goto(item("export-invoices-as-csv"));
    await page.click(".wide-only button[aria-label='add link']");
    await page.selectOption(".popup select[aria-label=type]", "wt-file");
    await page.fill(".popup input[aria-label=repo]", "/srv/demo");
    await page.fill(".popup input[aria-label=file]", "src/App.svelte");
    await page.click(".popup button.primary");
    const link = page.locator(".wide-only .rrow a", { hasText: "demo/src/App.svelte" });
    await link.waitFor();
    if (!/\/\?dir=%2Fsrv%2Fdemo&file=src%2FApp.svelte$/.test(await link.getAttribute("href"))) throw new Error("wrong href " + await link.getAttribute("href"));
  });

  await step("settings: the template data folds open", async () => {
    await page.goto(base + "/p/web/settings");
    await page.click(".template-ref > summary");
    await page.locator(".template-ref dt", { hasText: "{{item.repo_name}}" }).waitFor();
  });

  const autoRow = (key, repo = "acme/web") => page.locator(`.auto-rows[data-repo="${repo}"] .auto-row[data-row="${key}"]`);
  const card = (plugin) => autoRow(plugin).locator(".auto-panel.plugin-card");
  const inst = (id) => card("notes-link").locator(`.instance-card[data-instance="${id}"]`);
  const setting = (id, key) => inst(id).locator(`.setting[data-setting="${key}"]`);
  const configure = async (plugin) => {
    if (await card(plugin).count()) return;
    await autoRow(plugin).locator("button.link-btn", { hasText: /^(Set up|Settings) ›$/ }).first().click();
    await card(plugin).waitFor();
  };
  const savePlugin = async (plugin) => {
    await card(plugin).locator(".save-row button.primary", { hasText: "Save" }).click();
    await card(plugin).locator("fieldset.plugin-edit:not([disabled]) .save-row .hint", { hasText: "Saved." }).waitFor();
  };
  const saveEditor = async (plugin) => {
    const editor = card(plugin).locator(`[data-plugin-editor="${plugin}"]`);
    await editor.locator(".save-row button.primary", { hasText: "Save" }).click();
    await card(plugin).locator(`[data-plugin-editor="${plugin}"]:not([disabled]) .save-row .hint`, { hasText: "Saved." }).waitFor();
  };
  const moveOver = async (key, button, lines, repo = "acme/web") => {
    const row = autoRow(key, repo);
    await row.locator("button.link-btn", { hasText: `${button} ›` }).click();
    const panel = row.locator(".handover");
    for (const l of lines) await panel.locator("li", { hasText: l }).waitFor();
    return panel;
  };
  const rowState = (key, repo) => autoRow(key, repo).getAttribute("data-state");
  const automation = (repo) => base + "/p/web/settings/automation" + (repo ? "?repo=" + encodeURIComponent(repo) : "");
  /** Every step on the page is taken there: none names a server setting or a server admin. */
  const noServerSteps = async () => {
    const steps = await page.locator(".auto-steps li, .automation .hot, .automation .hint").allTextContents();
    const bad = steps.filter((t) => /Server admin|its admin|TODO_PLUGIN|GITHUB_TOKEN|TODO_[A-Z_]+/.test(t));
    if (bad.length) throw new Error("names a server setting: " + bad.join(" | "));
  };

  await step("automation: a settings tab, and the old Plugins address leads to it", async () => {
    await login("pat", "/p/web/settings");
    await page.locator(".settings-tabs").getByRole("link", { name: "Automation" }).click();
    await page.waitForURL(/\/p\/web\/settings\/automation$/);
    await page.locator(".automation-intro", { hasText: "Pick a repo to see what it does" }).waitFor();
    await page.goto(base + "/p/web/settings/plugins?repo=acme/api");
    await page.waitForURL(/\/settings\/automation\?repo=acme%2Fapi$/);
  });

  await step("automation: the picker opens on the repo most items name, keeps the choice in the URL, and adds and removes a repo", async () => {
    await page.goto(automation());
    const picker = page.locator("select[aria-label=repo]");
    if (await picker.inputValue() !== "acme/web") throw new Error("opened on " + await picker.inputValue());
    const options = await picker.locator("option").allTextContents();
    if (options[0] !== "acme/web · 3 items" || !options.includes("acme/api · 1 item")) throw new Error("options " + JSON.stringify(options));
    const checkoutOnly = await picker.locator("optgroup option").allTextContents();
    if (JSON.stringify(checkoutOnly) !== '["acme/infra","acme/tools"]') throw new Error("checkout-only " + JSON.stringify(checkoutOnly));
    await picker.selectOption("acme/api");
    await page.waitForURL(/\?repo=acme%2Fapi$/);
    await page.locator(".auto-rows[data-repo='acme/api']").waitFor();
    await page.click("button.add:has-text('Add a repo')");
    await page.fill("input[aria-label='add a repo']", "acme/extra");
    await page.click("button.primary:has-text('Add repo')");
    await page.waitForURL(/\?repo=acme%2Fextra$/);
    await page.locator(".auto-rows[data-repo='acme/extra']").waitFor();
    await page.click(".repo-pick button:has-text('Remove from project')");
    await page.locator(".auto-rows[data-repo='acme/web']").waitFor();
    if ((await picker.locator("option").allTextContents()).some((o) => o.startsWith("acme/extra"))) throw new Error("acme/extra still listed");
  });

  await step("automation: repos items name that the project can't read fold into one line, and Connect adds one, whatever its owner", async () => {
    const line = page.locator(".unconnected");
    await line.locator(".hint", { hasText: "2 repos your items name aren't connected yet: acme/docs, legacy/billing" }).waitFor();
    await line.locator("button", { hasText: "Connect ›" }).click();
    await line.locator(".rrow[data-repo='legacy/billing'] .hint", { hasText: "todo can read it once it's added to this project." }).waitFor();
    await line.locator(".rrow[data-repo='acme/docs'] button", { hasText: "Connect" }).click();
    await line.locator(".hint", { hasText: "1 repo your items name isn't connected yet: legacy/billing" }).waitFor();
    await page.locator("select[aria-label=repo] option", { hasText: "acme/docs · 1 item" }).waitFor({ state: "attached" });
    await line.locator(".rrow[data-repo='legacy/billing'] button", { hasText: "Connect" }).click();
    await line.waitFor({ state: "detached" });
    await page.goto(automation("legacy/billing"));
    const track = autoRow("track", "legacy/billing");
    await track.locator("li[data-connect=github]", { hasText: "Give todo a GitHub token that can read legacy/billing" }).waitFor();
    await noServerSteps();
    await page.click(".repo-pick button:has-text('Remove from project')");
    await page.locator(".auto-rows[data-repo='acme/web']").waitFor();
  });

  await step("automation: a repo nobody has set up has pr-link on, deploy branches first among what's off, a switch on each shipped plugin, and nothing to commit", async () => {
    await page.goto(automation("acme/api"));
    const order = await page.locator(".auto-rows[data-repo='acme/api'] .auto-row").evaluateAll((els) => els.map((e) => `${e.dataset.row}:${e.dataset.state}`));
    if (order[0] !== "pr-link:on") throw new Error("first row " + order[0]);
    const firstOff = order.find((r) => r.endsWith(":off"));
    if (firstOff !== "track:off") throw new Error("first off row " + firstOff + " in " + order.join(", "));
    await autoRow("pr-link", "acme/api").locator(".auto-line", { hasText: "Hasn't run yet." }).waitFor();
    if (await autoRow("pr-link", "acme/api").locator("input[role=switch]").count()) throw new Error("pr-link, always on, has a switch");
    const track = autoRow("track", "acme/api");
    await track.locator(".auto-title", { hasText: "Show where work has landed" }).waitFor();
    await track.locator(".auto-line", { hasText: "in staging ✓ · in main ✗" }).waitFor();
    await track.locator("li", { hasText: "Name the branches work deploys from" }).waitFor();
    const vercel = autoRow("vercel-preview", "acme/api");
    if (await vercel.locator("input[aria-label='vercel-preview on']").isChecked()) throw new Error("vercel-preview starts on");
    await vercel.locator("li", { hasText: "Connect todo to Vercel with a token." }).waitFor();
    await vercel.locator("li", { hasText: "once it's switched on" }).waitFor();
    if (await vercel.locator("button:has-text('Set up')").count()) throw new Error("offers settings for a plugin that's off");
    if (await page.locator(".step-code pre, code.env").count()) throw new Error("a step asks someone to commit to the repo or set the server's environment");
    if (await page.getByText("In the repo").count()) throw new Error("a step is the repo's");
    await noServerSteps();
    await page.screenshot({ path: out + "/automation-unset.png", fullPage: true });
  });

  await step("automation: deploy branches are typed into a field that suggests the remote's, and turn the row on", async () => {
    const track = autoRow("track", "acme/api");
    await track.locator("li:not([data-connect]) button", { hasText: "Set up ›" }).click();
    const field = track.locator(".branches-panel input[aria-label='deploy branches']");
    if (await field.inputValue() !== "") throw new Error("the field starts with " + await field.inputValue());
    if (await field.getAttribute("placeholder") !== "e.g. main, staging") throw new Error("placeholder " + await field.getAttribute("placeholder"));
    const chips = await track.locator(".branch-suggest .chip").allTextContents();
    if (JSON.stringify(chips) !== '["+ main","+ staging"]') throw new Error("suggests " + JSON.stringify(chips));
    await track.locator(".branch-suggest .chip", { hasText: "staging" }).click();
    await track.locator(".branch-suggest .chip", { hasText: "main" }).click();
    if (await field.inputValue() !== "staging, main") throw new Error("the field holds " + await field.inputValue());
    await page.screenshot({ path: out + "/automation-branches.png", fullPage: true });
    await track.locator(".branches-panel button.primary", { hasText: "Save" }).click();
    await track.locator(".auto-title", { hasText: "Show where work has landed (staging, main)" }).waitFor();
    if (await rowState("track", "acme/api") !== "on") throw new Error("deploy branches are " + await rowState("track", "acme/api"));
  });

  await step("automation: switching Vercel on asks for its token in the row, the address filled in, and saving it connects todo", async () => {
    const vercel = autoRow("vercel-preview", "acme/api");
    await vercel.locator("input[aria-label='vercel-preview on']").check();
    await page.locator(".auto-rows[data-repo='acme/api'] .auto-row[data-row='vercel-preview'][data-state=setup]").waitFor();
    await vercel.locator("li[data-connect=vercel] button", { hasText: "Set up ›" }).click();
    const form = vercel.locator("form.conn-form[data-connection-form=vercel]");
    if (await form.locator("input[aria-label='Vercel address']").inputValue() !== "https://api.vercel.com") throw new Error("the address isn't filled in");
    if (await form.locator("a[href='https://vercel.com/account/tokens']").count() !== 1) throw new Error("no link to make a token");
    await form.locator("input[aria-label='Vercel token']").fill("smoke-vercel-token");
    await page.screenshot({ path: out + "/automation-connect.png", fullPage: true });
    await form.locator("button.primary", { hasText: "Save" }).click();
    await vercel.locator("li.done[data-connect=vercel]", { hasText: "Connected to Vercel." }).waitFor();
    if ((await page.content()).includes("smoke-vercel-token")) throw new Error("the token came back to the page");
    await page.locator(".project-connections .host-conn[data-connection=vercel][data-source=page]", { hasText: "Set by pat" }).waitFor();
    await noServerSteps();
  });

  await step("automation: switching a shipped plugin on gives it settings here, and switching it off keeps them", async () => {
    const vercel = autoRow("vercel-preview", "acme/api");
    await vercel.locator("li:not([data-connect]) button", { hasText: "Set up ›" }).click();
    const card = vercel.locator(".auto-panel.plugin-card");
    await card.locator(".setting[data-setting=project] input").fill("prj_smoke");
    await card.locator(".setting[data-setting=team] input").fill("team_smoke");
    await card.locator(".save-row button.primary", { hasText: "Save" }).click();
    await card.locator("fieldset.plugin-edit:not([disabled]) .save-row .hint", { hasText: "Saved." }).waitFor();
    await vercel.locator("input[aria-label='vercel-preview on']").uncheck();
    await page.locator(".auto-rows[data-repo='acme/api'] .auto-row[data-row='vercel-preview'][data-state=off]").waitFor();
    await vercel.locator("input[aria-label='vercel-preview on']").check();
    await page.locator(".auto-rows[data-repo='acme/api'] .auto-row[data-row='vercel-preview']:not([data-state=off])").waitFor();
    if (!(await card.count())) await vercel.locator("button.link-btn", { hasText: /^(Set up|Settings) ›$/ }).first().click();
    if (await card.locator(".setting[data-setting=project] input").inputValue() !== "prj_smoke") throw new Error("its settings didn't stay");
  });

  await step("automation: a custom plugin is added from YAML checked as it's typed, edited, and removed", async () => {
    await page.goto(automation("acme/api"));
    page.once("dialog", (d) => d.accept());
    await page.click("button.add:has-text('Add a custom plugin')");
    const editor = page.locator(".custom-editor[data-custom=new]");
    await editor.locator("input[aria-label='plugin name']").fill("smoke-hello");
    const yaml = editor.locator("textarea[aria-label='plugin yaml']");
    await yaml.fill("description: Logs hello from the smoke.\non: [manual]\nwat: 1\nattach:\n  - log: \"hello {{item.id}}\"\n");
    await editor.locator(".problems .error", { hasText: 'unknown key "wat"' }).waitFor();
    if (!(await editor.locator("button.primary").isDisabled())) throw new Error("a plugin with errors can be saved");
    await yaml.fill("description: Logs hello from the smoke.\non: [manual]\ncode: hello.js\n");
    await editor.locator("textarea[aria-label='plugin code']").waitFor();
    await editor.locator(".problems .error", { hasText: "code names hello.js: paste that file's code" }).waitFor();
    await editor.locator("textarea[aria-label='plugin code']").fill("export function run({ attach, item }) { attach.log('hello ' + item.id); }\n");
    await editor.locator(".problems").waitFor({ state: "detached" });
    await page.screenshot({ path: out + "/automation-custom.png", fullPage: true });
    await editor.locator("button.primary", { hasText: "Add plugin" }).click();
    const row = autoRow("smoke-hello", "acme/api");
    await row.locator(".auto-title", { hasText: "Logs hello from the smoke" }).waitFor();
    if (await rowState("smoke-hello", "acme/api") !== "on") throw new Error("smoke-hello is " + await rowState("smoke-hello", "acme/api"));
    await row.locator("button.link-btn", { hasText: "Edit YAML ›" }).click();
    if (!(await row.locator("textarea[aria-label='plugin yaml']").inputValue()).includes("code: hello.js")) throw new Error("the editor lost the YAML");
    await row.locator("button.danger", { hasText: "Remove plugin" }).click();
    await row.waitFor({ state: "detached" });
  });

  await step("automation: a connection is declared for custom plugins, edited in place, and removed with its credential", async () => {
    const section = page.locator(".auto-rows[data-repo='acme/api'] #connections");
    await section.locator("button.add", { hasText: "Add a connection" }).click();
    await section.locator("input[aria-label='connection name']").fill("smoke-hooks");
    await section.locator("input[aria-label='connection url']").fill("https://hooks.example.com");
    await section.locator("select[aria-label='connection auth']").selectOption("bearer");
    await section.locator("button.primary", { hasText: "Add" }).click();
    const row = section.locator(".conn-row[data-connection=smoke-hooks]");
    await row.locator(".grow", { hasText: "No credential on this server" }).waitFor();
    await row.locator(".conn-url", { hasText: "http https://hooks.example.com" }).waitFor();
    await row.locator("button[aria-label='edit smoke-hooks']").click();
    await row.locator("input[aria-label='smoke-hooks url']").fill("https://hooks2.example.com");
    await row.locator("input[aria-label='smoke-hooks new secret']").fill("hooks-secret");
    await row.locator(".edit-connection button.primary", { hasText: "Save" }).click();
    await row.locator(".conn-url", { hasText: "http https://hooks2.example.com" }).waitFor();
    if ((await page.content()).includes("hooks-secret")) throw new Error("the credential came back to the page");
    page.once("dialog", (d) => d.accept());
    await row.locator("button[aria-label='remove smoke-hooks']").click();
    await row.waitFor({ state: "detached" });
  });

  await step("automation: what the Jira bridge and Actions do today shows as elsewhere, linking to the General tab", async () => {
    for (const key of ["jira-transition", "jira-issue", "rest", "watchtower-session"]) {
      if (await rowState(key, "acme/api") !== "elsewhere") throw new Error(`${key} is ${await rowState(key, "acme/api")}`);
    }
    await autoRow("jira-transition", "acme/api").locator(".auto-line", { hasText: "3 triggers in the Jira bridge move tickets today" }).waitFor();
    await autoRow("watchtower-session", "acme/api").locator(".auto-line", { hasText: '"Start agent"' }).waitFor();
    await autoRow("jira-transition", "acme/api").getByRole("link", { name: "General → Jira ›" }).click();
    await page.waitForURL(/\/p\/web\/settings#jira$/);
    await page.locator("#jira").waitFor();
  });

  await step("automation: a repo with deploy branches shows them on, a plugin's last run, the steps left, and work both a plugin and the bridge would do", async () => {
    await page.goto(automation("acme/web"));
    await autoRow("track").locator(".auto-title", { hasText: "Show where work has landed (staging, main)" }).waitFor();
    if (await rowState("track") !== "on") throw new Error("deploy branches aren't on");
    await autoRow("pr-link").locator(".last", { hasText: "linked PR #41 · Per-project API tokens on per-project-api-tokens" }).waitFor();
    const jt = autoRow("jira-transition");
    if (await rowState("jira-transition") !== "setup") throw new Error("jira-transition is " + await rowState("jira-transition"));
    await jt.locator(".auto-line", { hasText: "The Jira bridge also has 3 triggers, which only record the moves they'd make." }).waitFor();
    if (!(await jt.locator("input[aria-label='jira-transition on']").isChecked())) throw new Error("jira-transition's switch is off");
    await jt.locator("li[data-connect=jira]", { hasText: "Connect todo to Jira with an email and API token." }).waitFor();
    await noServerSteps();
    await autoRow("rest").locator(".auto-line", { hasText: "items would get both buttons" }).waitFor();
    await autoRow("ping").locator(".auto-line", { hasText: "A custom plugin of this repo" }).waitFor();
    await page.screenshot({ path: out + "/automation-page.png", fullPage: true });
    await autoRow("vercel-preview").locator("li:not([data-connect]) button", { hasText: "Set up ›" }).click();
    await card("vercel-preview").locator(".setting[data-setting=project] input").waitFor();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: out + "/automation-setup.png", fullPage: true });
  });

  await step("automation: settings open in place, with labelled instance fields, where each runs, and the credential a plugin needs", async () => {
    if (await inst("go").isVisible()) throw new Error("instances show before Settings");
    await configure("notes-link");
    await inst("go").locator(".field", { hasText: "Name" }).locator("input").waitFor();
    await inst("go").locator(".field", { hasText: "Id" }).locator("input").waitFor();
    await inst("go").locator(".check", { hasText: "Test mode: show what it would do without doing it" }).waitFor();
    if (await inst("go").locator(".order").count()) throw new Error("order arrows on a plugin where order changes nothing");
    await card("notes-link").locator(".plugin-meta", { hasText: "Runs when someone presses its button" }).waitFor();
    await inst("go").locator(".runs-where", { hasText: "Runs on the server." }).waitFor();
    if (await rowState("ping") !== "setup") throw new Error("ping is " + await rowState("ping"));
    await autoRow("ping").locator("li", { hasText: "Enter the hooks credential." }).waitFor();
    const note = await setting("go", "jira").locator(".hint").textContent();
    if (!note.includes("list_statuses")) throw new Error("no options_from note: " + note);
    if (await setting("go", "jira").locator("select").count()) throw new Error("an options_from choice rendered as a select");
  });

  await step("automation: every setting type saves, and triggers, button and plugin-wide settings with it", async () => {
    await setting("go", "title").locator("input").fill("Smoke notes");
    await setting("go", "body").locator("textarea").fill("line one\nline two");
    await setting("go", "model").locator("select").selectOption("sonnet");
    await setting("go", "jira").locator("input").fill("In Review");
    await setting("go", "loud").locator("input[type=checkbox]").check();
    await setting("go", "retries").locator("input").fill("3");
    await setting("go", "tags").locator("textarea").fill("a\nb");
    await setting("go", "token").locator("input[type=password]").fill("s3cret");
    await card("notes-link").locator(".plugin-shared .setting[data-setting=never] textarea").fill("Done");
    await inst("go").locator("input[aria-label=\"go uses the plugin's triggers\"]").uncheck();
    await inst("go").locator(".triggers button.add").click();
    await inst("go").locator(".triggers .rule-row[data-trigger=status] select[aria-label='to status']").selectOption("review");
    await inst("go").locator("input[aria-label='button label']").fill("Link smoke notes");
    await page.screenshot({ path: out + "/automation-settings.png", fullPage: true });
    await savePlugin("notes-link");
    await setting("go", "token").locator(".tag", { hasText: "set" }).waitFor();
    const values = {
      title: await setting("go", "title").locator("input").inputValue(),
      body: await setting("go", "body").locator("textarea").inputValue(),
      model: await setting("go", "model").locator("select").inputValue(),
      jira: await setting("go", "jira").locator("input").inputValue(),
      loud: await setting("go", "loud").locator("input").isChecked(),
      retries: await setting("go", "retries").locator("input").inputValue(),
      tags: await setting("go", "tags").locator("textarea").inputValue(),
      token: await setting("go", "token").locator("input[type=password]").inputValue(),
      never: await card("notes-link").locator(".plugin-shared .setting[data-setting=never] textarea").inputValue(),
      triggers: await inst("go").locator(".triggers .rule-row").count(),
      button: await inst("go").locator("input[aria-label='button label']").inputValue(),
    };
    const want = { title: "Smoke notes", body: "line one\nline two", model: "sonnet", jira: "In Review", loud: true, retries: "3", tags: "a\nb",
                   token: "", never: "Done", triggers: 2, button: "Link smoke notes" };
    if (JSON.stringify(values) !== JSON.stringify(want)) throw new Error("after save: " + JSON.stringify(values));
    if ((await page.content()).includes("s3cret")) throw new Error("the secret came back to the page");
  });

  await step("automation: the web-request row lays its buttons out like an Action, offering the repo's connections and the server's, with template data", async () => {
    await page.goto(automation("acme/web"));
    await autoRow("rest").locator(".auto-title", { hasText: "Send a web request to any URL" }).waitFor();
    await configure("rest");
    const rest = card("rest").locator("[data-plugin-editor=rest]");
    await rest.locator(".hint", { hasText: "sends a web request to any URL" }).waitFor();
    const hook = rest.locator('.action-card[data-card="hook"]');
    const choices = await hook.locator("select[aria-label=connection] option").allTextContents();
    if (!choices.includes("github") || !choices.includes("hooks") || !choices.includes("+ New connection…")) throw new Error("a button offered " + choices.join(", "));
    if (await hook.locator("input[aria-label=path]").inputValue() !== "/notify/{{item.id}}") throw new Error("the path isn't shown");
    await rest.locator(".template-ref > summary").click();
    await rest.locator(".template-ref dt", { hasText: "{{event.from}}" }).waitFor();
    await hook.locator("select[aria-label=method]").selectOption("GET");
    if (await hook.locator("textarea[aria-label=body]").count()) throw new Error("a GET has a body");
    await page.screenshot({ path: out + "/automation-rest.png", fullPage: true });
    await page.reload();
  });

  await step("automation: a web-request button is pointed at a brand-new endpoint entirely on the page", async () => {
    await configure("rest");
    const rest = card("rest").locator("[data-plugin-editor=rest]");
    await rest.locator("button.add", { hasText: "button" }).click();
    const fresh = rest.locator('.action-card[data-card="new"]');
    await fresh.locator("input[aria-label='button name']").fill("Ping smoke");
    await fresh.locator("select[aria-label=connection]").selectOption({ label: "+ New connection…" });
    const form = fresh.locator(".new-connection form.conn-form");
    await form.locator("input[aria-label='connection name']").fill("smoke-api");
    await form.locator("input[aria-label='smoke-api address']").fill("https://api.smoke-test.example");
    await form.locator("select[aria-label='smoke-api auth']").selectOption("bearer");
    await form.locator("input[aria-label='smoke-api token']").fill("smoke-api-secret");
    await form.locator("button.primary", { hasText: "Save" }).click();
    await form.waitFor({ state: "detached" });
    if (await fresh.locator("select[aria-label=connection]").inputValue() !== "smoke-api") throw new Error("the new connection isn't picked");
    await fresh.locator("input[aria-label=path]").fill("/ping/{{item.id}}");
    await fresh.locator("button.add", { hasText: "status move" }).click();
    await fresh.locator(".rule-table select[aria-label='to status']").selectOption("review");
    await saveEditor("rest");
    await card("rest").locator('.action-card[data-card="ping-smoke"] input[aria-label=path]').waitFor();
    await page.locator(".project-connections .host-conn[data-connection=smoke-api]", { hasText: "https://api.smoke-test.example" }).waitFor();
    if ((await page.content()).includes("smoke-api-secret")) throw new Error("the secret came back to the page");
    await noServerSteps();
  });

  await step("automation: a connection on a private address is saved only once someone allows it, which the page records", async () => {
    const section = page.locator(".auto-rows[data-repo='acme/web'] .project-connections");
    await section.locator("button.add", { hasText: "Add a connection" }).click();
    const form = section.locator("form.conn-form[data-connection-form=new]");
    await form.locator("input[aria-label='connection name']").fill("local-hooks");
    await form.locator("input[aria-label='local-hooks address']").fill("http://127.0.0.1:10077");
    await form.locator("button.primary", { hasText: "Save" }).click();
    const allow = form.locator(".private-ok", { hasText: "This address is on your private network: allow todo to call it" });
    await allow.waitFor();
    await allow.locator("input").check();
    await form.locator("button.primary", { hasText: "Save" }).click();
    const line = section.locator(".host-conn[data-connection=local-hooks]");
    await line.waitFor();
    await line.locator("button", { hasText: "Change" }).click();
    await line.locator(".hint", { hasText: "Private address allowed by pat" }).waitFor();
    page.once("dialog", (d) => d.accept());
    await line.locator("button.danger", { hasText: "Remove" }).click();
    await line.waitFor({ state: "detached" });
  });

  await step("automation: a stored secret is kept when untouched, and cleared on request", async () => {
    await configure("notes-link");
    await setting("go", "title").locator("input").fill("Smoke notes 2");
    await savePlugin("notes-link");
    await setting("go", "title").locator("input[value='Smoke notes 2']").waitFor();
    await setting("go", "token").locator(".tag", { hasText: "set" }).waitFor();
    await setting("go", "token").locator("button[aria-label='clear Token']").click();
    await setting("go", "token").locator(".tag", { hasText: "cleared on save" }).waitFor();
    await savePlugin("notes-link");
    await setting("go", "token").locator("input[placeholder='not set']").waitFor();
    if (await setting("go", "token").locator(".tag", { hasText: "set" }).count()) throw new Error("the secret is still set");
  });

  await step("automation: add, duplicate and remove instances", async () => {
    await card("notes-link").locator("button.add:has-text('instance')").click();
    await inst("instance").waitFor();
    await inst("go").locator("button[aria-label='duplicate go']").click();
    await inst("go-copy").waitFor();
    const order = () => card("notes-link").locator(".instance-card").evaluateAll((els) => els.map((e) => e.dataset.instance));
    if (JSON.stringify(await order()) !== '["go","go-copy","instance"]') throw new Error("order " + JSON.stringify(await order()));
    if (await card("notes-link").locator(".order").count()) throw new Error("order arrows on a plugin that fires every instance");
    await inst("instance").locator("button[aria-label='remove instance']").click();
    await inst("go-copy").locator("button[aria-label='remove go-copy']").click();
    await inst("instance").waitFor({ state: "detached" });
    if (await inst("go-copy").count()) throw new Error("go-copy wasn't removed");
    if (JSON.stringify(await order()) !== '["go"]') throw new Error("left " + JSON.stringify(await order()));
  });

  await step("automation: Jira is set up in jira-transition's row with its site, email and API token, at a private address once allowed", async () => {
    await page.goto(automation("acme/web"));
    const jt = autoRow("jira-transition");
    await jt.locator("li[data-connect=jira] button", { hasText: "Set up ›" }).click();
    const form = jt.locator("form.conn-form[data-connection-form=jira]");
    await form.locator("input[aria-label='Jira address']").fill(jiraUrl);
    await form.locator("input[aria-label='Jira email']").fill("smoke@acme.test");
    await form.locator("input[aria-label='Jira api token']").fill("smoke-jira-token");
    await form.locator("button.primary", { hasText: "Save" }).click();
    await form.locator(".private-ok input").check();
    await form.locator("button.primary", { hasText: "Save" }).click();
    await jt.locator("li.done[data-connect=jira]", { hasText: "Connected to Jira." }).waitFor();
    if ((await page.content()).includes("smoke-jira-token")) throw new Error("the token came back to the page");
    const polling = await moveOver("jira-issue", "Move polling here", ["the Jira bridge stops polling this project",
      "It adds a newly linked ticket's summary and description to the item's request"]);
    if (await polling.locator("button.primary").isDisabled()) throw new Error("jira-issue's move is blocked: " + await polling.locator(".hot").allTextContents());
    await polling.locator("button", { hasText: "Cancel" }).click();
    await noServerSteps();
  });

  await step("automation: the Jira bridge's triggers move here once the page says what will happen", async () => {
    const panel = await moveOver("jira-transition", "Move these triggers here", ["3 triggers move here, in order, for", "the Jira bridge stops moving tickets",
                                                                                "Send to Jira stays off"]);
    await page.screenshot({ path: out + "/automation-jira-move.png", fullPage: true });
    await panel.locator("button.primary", { hasText: "Move these triggers here" }).click();
    await panel.waitFor({ state: "detached" });
    await autoRow("jira-transition").locator("button.link-btn", { hasText: "Move these triggers back to the Jira bridge ›" }).waitFor();
    if (await autoRow("jira-transition").locator("button.move-here").count()) throw new Error("still offers to move the triggers here");
  });

  await step("automation: jira-transition's triggers are edited with Jira's own statuses, in order, tried, and saved", async () => {
    await configure("jira-transition");
    const ed = card("jira-transition").locator("[data-plugin-editor=jira-transition]");
    const rows = ed.locator(".rule-table .rule-row");
    if (await rows.count() !== 3) throw new Error(`${await rows.count()} triggers`);
    await rows.nth(0).locator("select[aria-label='Jira status'] option", { hasText: "In Progress" }).waitFor({ state: "attached" });
    if (await ed.locator("input[type=checkbox]").first().isChecked()) throw new Error("Send to Jira is on after a move from a bridge that only recorded");
    await rows.nth(0).locator("select[aria-label='Jira status']").selectOption("In Progress");
    await ed.locator("button.add", { hasText: "trigger" }).click();
    await rows.nth(3).locator("select[aria-label='from todo status']").selectOption("*");
    await rows.nth(3).locator("select[aria-label='to todo status']").selectOption("deployed");
    await rows.nth(3).locator("select[aria-label='Jira status']").selectOption("Done");
    await ed.locator("button[aria-label='move trigger 4 up']").click();
    await ed.locator(".problems .warning", { hasText: "The trigger ready-to-deploy → deployed never runs: * → deployed above it matches first." }).waitFor();
    await ed.locator("select[aria-label='test from']").selectOption("in-qa");
    await ed.locator("select[aria-label='test to']").selectOption("deployed");
    await ed.locator(".tester .result", { hasText: "moves Jira to Done." }).waitFor();
    await page.screenshot({ path: out + "/automation-jira-editor.png", fullPage: true });
    await saveEditor("jira-transition");
    const saved = card("jira-transition").locator("[data-plugin-editor=jira-transition] .rule-table .rule-row");
    const order = await saved.evaluateAll((els) => els.map((e) => e.dataset.trigger));
    if (JSON.stringify(order) !== '["review>ready-for-qa","qa-approved>ready-to-deploy","*>deployed","ready-to-deploy>deployed"]') throw new Error("saved " + JSON.stringify(order));
    if (await saved.nth(0).locator("select[aria-label='Jira status']").inputValue() !== "In Progress") throw new Error("the picked Jira status didn't stay");
  });

  await step("automation: jira-transition's triggers move back to the Jira bridge, once none needs what the bridge can't do", async () => {
    let panel = await moveOver("jira-transition", "Move these triggers back to the Jira bridge", []);
    await panel.locator(".hot", { hasText: "The trigger * → deployed can't go back: the Jira bridge needs both statuses." }).waitFor();
    if (!(await panel.locator("button.primary").isDisabled())) throw new Error("the way back is open with a * trigger");
    await panel.locator("button", { hasText: "Cancel" }).click();
    await configure("jira-transition");
    const ed = card("jira-transition").locator("[data-plugin-editor=jira-transition]");
    await ed.locator(".rule-table .rule-row[data-trigger='*>deployed'] button[aria-label='remove trigger']").click();
    await saveEditor("jira-transition");
    panel = await moveOver("jira-transition", "Move these triggers back to the Jira bridge", ["3 triggers from acme/web go back to the Jira bridge",
                                                                                              "jira-transition is switched off in"]);
    await panel.locator("button.primary", { hasText: "Move these triggers back to the Jira bridge" }).click();
    await page.locator(".auto-rows[data-repo='acme/web'] .auto-row[data-row='jira-transition'][data-state=elsewhere]").waitFor();
    await page.goto(base + "/p/web/settings");
    const general = page.locator(".jira-settings .rule-table .rule-row");
    if (await general.count() !== 3) throw new Error(`the bridge has ${await general.count()} triggers`);
    if (await general.nth(0).locator("input[aria-label='Jira status'], select[aria-label='Jira status']").inputValue() !== "In Progress") throw new Error("the edit didn't go back");
  });

  await step("automation: the Watchtower Action moves here as a Watchtower button once the page says what will happen", async () => {
    await page.goto(automation("acme/web"));
    const wt = autoRow("watchtower-session");
    await wt.locator(".auto-title", { hasText: "Start or resume a Claude session in Watchtower" }).waitFor();
    const panel = await moveOver("watchtower-session", "Move these Actions here", ['1 Action moves here as watchtower-session buttons', '"Start agent"',
      "It leaves the General tab, so items never show both buttons or fire both.", "Adds this project's watchtower connection at http://watchtower.example:10011"]);
    await panel.locator("button.primary", { hasText: "Move these Actions here" }).click();
    await panel.waitFor({ state: "detached" });
    await page.locator(".project-connections .host-conn[data-connection=watchtower]", { hasText: "http://watchtower.example:10011" }).waitFor();
    await page.goto(base + "/p/web/settings");
    await page.locator(".actions-settings .hint", { hasText: 'Moved to Settings → Automation, where plugins run them: "Start agent"' }).waitFor();
    if (await page.locator('.action-card[data-action="start-agent"]').count()) throw new Error("the Action is still on the General tab");
  });

  await step("automation: a Watchtower button is edited like an Action: name, folder, model, resume prompts, the moves it fires on, and order", async () => {
    await page.goto(automation("acme/web"));
    await configure("watchtower-session");
    const ed = card("watchtower-session").locator("[data-plugin-editor=watchtower-session]");
    await ed.locator(".hint", { hasText: "The Watchtower plugin: each button hands the item to its Claude session in Watchtower" }).waitFor();
    const agent = ed.locator('.action-card[data-card="action-start-agent"]');
    if (await agent.locator("input[aria-label='button name']").inputValue() !== "Start agent") throw new Error("the name isn't shown");
    if (await agent.locator("input[aria-label=folder]").inputValue() !== "/src/web") throw new Error("the folder isn't shown");
    await agent.locator("select[aria-label=model]").selectOption("haiku");
    await agent.locator("label.check", { hasText: "resume the item's last session instead of starting a new one" }).locator("input").check();
    await agent.locator("textarea[aria-label='resume prompt']").fill("/todo {{item.id}} again");
    await agent.locator(".hint", { hasText: "else resumes its last stopped one with its history" }).waitFor();
    await agent.locator("button.add", { hasText: "status move" }).click();
    await agent.locator(".rule-table select[aria-label='to status']").selectOption("in-progress");
    await ed.locator("button.add", { hasText: "button" }).click();
    const fresh = ed.locator('.action-card[data-card="new"]');
    await fresh.locator("input[aria-label='button name']").fill("Smoke session");
    if (await fresh.locator("input[aria-label=folder]").getAttribute("placeholder") !== "{{item.dir}}") throw new Error("the folder doesn't default to the item's");
    await fresh.locator("button[aria-label='move Smoke session up']").click();
    await page.screenshot({ path: out + "/automation-watchtower.png", fullPage: true });
    await saveEditor("watchtower-session");
    const cards = await card("watchtower-session").locator(".action-card").evaluateAll((els) => els.map((e) => e.dataset.card));
    if (JSON.stringify(cards) !== '["smoke-session","action-start-agent"]') throw new Error("saved " + JSON.stringify(cards));
    const kept = card("watchtower-session").locator('.action-card[data-card="action-start-agent"]');
    if (await kept.locator("select[aria-label=model]").inputValue() !== "haiku") throw new Error("the model didn't stay");
    if (await kept.locator("textarea[aria-label='resume prompt']").inputValue() !== "/todo {{item.id}} again") throw new Error("the resume prompt didn't stay");
  });

  await step("item: a moved Action is one button, the plugin's", async () => {
    await page.goto(item("plugin-playground"));
    const buttons = page.locator(".wide-only .action-buttons button", { hasText: "Start agent" });
    await buttons.first().waitFor();
    if (await buttons.count() !== 1) throw new Error(`${await buttons.count()} Start agent buttons`);
    await page.locator(".wide-only [data-plugin-button='watchtower-session/action-start-agent']").waitFor();
  });

  await step("automation: the REST Action moves here as a web-request button, and both move back to the General tab", async () => {
    await page.goto(automation("acme/web"));
    let panel = await moveOver("rest", "Move these Actions here", ['1 Action moves here as rest buttons', '"Notify deploy"']);
    await panel.locator("button.primary", { hasText: "Move these Actions here" }).click();
    await panel.waitFor({ state: "detached" });
    await configure("rest");
    const notify = card("rest").locator('.action-card[data-card="action-notify-deploy"]');
    if (await notify.locator("input[aria-label=path]").inputValue() !== "/deploys") throw new Error("the path isn't the Action's");
    for (const [key, n] of [["rest", "1 Action goes back"], ["watchtower-session", "1 Action goes back"]]) {
      panel = await moveOver(key, "Move these Actions back to the General tab", [n]);
      await panel.locator("button.primary", { hasText: "Move these Actions back to the General tab" }).click();
      await panel.waitFor({ state: "detached" });
    }
    await page.goto(base + "/p/web/settings");
    for (const id of ["start-agent", "notify-deploy"]) await page.locator(`.action-card[data-action="${id}"]`).waitFor();
    await page.goto(automation("acme/web"));
  });

  await step("automation: a connection's credential is set and cleared, never shown, and turns the row on", async () => {
    await autoRow("ping").locator("li:not([data-connect]) button", { hasText: "Set up ›" }).click();
    const row = card("ping").locator(".conn-row[data-connection=hooks]");
    await row.locator("button:has-text('Set credential')").click();
    await row.locator("input[type=password]").fill("hook-secret");
    await row.locator("button.primary:has-text('Save')").click();
    await row.locator(".grow", { hasText: "Credential stored." }).waitFor();
    if ((await page.content()).includes("hook-secret")) throw new Error("the credential came back to the page");
    await autoRow("ping").locator(".auto-line", { hasText: "Hasn't run yet." }).waitFor();
    if (await rowState("ping") !== "on") throw new Error("ping is " + await rowState("ping"));
    await row.locator("button:has-text('Clear')").click();
    await row.locator(".grow", { hasText: "No credential on this server" }).waitFor();
  });

  await step("item: a plugin's manual button runs it, and what it attached is labelled with the plugin", async () => {
    await page.goto(item("plugin-playground"));
    const button = page.locator(".wide-only [data-plugin-button='notes-link/go'] button", { hasText: "Link smoke notes" });
    await button.click();
    await page.locator(".toast", { hasText: "Link smoke notes: attached 1 link" }).waitFor({ timeout: 20000 });
    const link = page.locator(".wide-only .rrow", { hasText: "Smoke notes 2" });
    await link.waitFor({ timeout: 10000 });
    const by = await link.locator(".plugin-by").textContent();
    if (by !== "notes-link · go") throw new Error("label " + by);
    await page.screenshot({ path: out + "/item-plugins.png", fullPage: true });
  });

  await step("automation: the row names its last run, and History lists it with its item and what it attached", async () => {
    await page.goto(automation("acme/web"));
    await autoRow("notes-link").locator(".last", { hasText: "linked Smoke notes 2 on plugin-playground" }).waitFor();
    await autoRow("notes-link").locator("button", { hasText: "History ›" }).click();
    const run = autoRow("notes-link").locator(".run-row", { hasText: "plugin-playground" }).first();
    await run.locator(".tag", { hasText: "ran" }).waitFor();
    await run.locator("summary").click();
    await run.locator(".run-detail li", { hasText: "Smoke notes 2" }).waitFor();
  });

  await step("item: staging past an unresolved dependency lists it and stages anyway", async () => {
    await page.goto(item("signed-webhook-payloads"));
    await pickStatus("ready-to-deploy");
    const dialog = page.locator(".popup", { hasText: "Stage with 1 unresolved dependency?" });
    await dialog.locator(".wait-list li", { hasText: "per-project-api-tokens" }).waitFor();
    await dialog.locator(".wait-list li", { hasText: "feat/api-tokens" }).waitFor();
    await page.screenshot({ path: out + "/stage-anyway.png", fullPage: true });
    await dialog.locator("button", { hasText: "Stage anyway" }).click();
    await dialog.waitFor({ state: "detached" });
    await page.locator(".head .stat-label", { hasText: "ready-to-deploy" }).first().waitFor();
  });

  await step("display: a wall shows plugin labels and no plugin buttons", async () => {
    const wall = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const wp = await wall.newPage();
    await wp.goto(base + "/display/web/enroll?key=wall-test");
    await wp.goto(base + "/display/web/i/plugin-playground");
    await wp.locator(".plugin-by:visible", { hasText: "notes-link · go" }).first().waitFor();
    if (await wp.locator("[data-plugin-button], .plugins-rail").count()) throw new Error("the wall shows plugin buttons");
    await wall.close();
  });

  await step("the board uses a wide screen", async () => {
    const wide = await browser.newContext({ viewport: { width: 2400, height: 900 } });
    await wide.addCookies(await ctx.cookies());
    const wp = await wide.newPage();
    await wp.goto(base + "/p/web");
    const w = await wp.evaluate(() => document.querySelector("main").getBoundingClientRect().width);
    if (w < 2000) throw new Error(`main is only ${w}px wide`);
    await wp.screenshot({ path: out + "/board-wide.png" });
    await wide.close();
  });

  await step("narrow screens never scroll sideways", async () => {
    const mobile = await browser.newContext({ viewport: { width: 400, height: 860 } });
    await mobile.addCookies(await ctx.cookies());
    const mp = await mobile.newPage();
    for (const path of ["/p/web", "/p/web/i/export-invoices-as-csv", "/p/web/i/safari-login-fails-after-password-reset", "/p/web/qa", "/p/web/deploy", "/inbox",
                        "/p/web/settings/automation?repo=acme%2Fapi"]) {
      await mp.goto(base + path);
      await mp.waitForTimeout(400);
      const wide = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1
        && [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1
             && !e.closest(".board")).map((e) => `${e.tagName.toLowerCase()}.${e.className}`).slice(0, 3).join(", "));
      if (wide !== false) throw new Error(`${path} overflows: ${wide}`);
    }
    await mp.goto(base + "/p/web/i/export-invoices-as-csv");
    await mp.screenshot({ path: out + "/item-mobile.png", fullPage: true });
    await mobile.close();
  });

  await browser.close();
  fakeJira.close();
  console.log("errors:", JSON.stringify(errors));
  process.exit(errors.length ? 1 : 0);
})();
