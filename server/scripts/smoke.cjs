// UI smoke run against a seeded server:
//   TOKENS=<file with {"pat","dev","qa"} tokens> BASE_URL=http://<host>:<port> SHOTS=<dir> node scripts/smoke.cjs
// Seed with `TODO_PGLITE=<dir> npm run seed:demo`, then start the server on the
// same dir. Point BASE_URL at a real hostname rather than localhost: browsers
// treat localhost as secure, which hides cookie problems on plain-http hosts.
const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");

const tokens = process.env.TOKENS ? JSON.parse(fs.readFileSync(process.env.TOKENS, "utf8")) : { pat: "pat-test", dev: "dev-test", qa: "qa-test" };
const base = process.env.BASE_URL || "http://127.0.0.1:3917";
const out = process.env.SHOTS || os.tmpdir();
const errors = [];
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

(async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + "/login"); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
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
    for (const t of ["Requested", "Triage", "In progress", "QA", "Ready to deploy"]) await page.getByRole("region", { name: t }).waitFor();
    await page.click("button:has-text('Mine')");
    await page.waitForURL(/f=dev%3Adev%2Cqa%3Adev%2Cby%3Adev|f=dev:dev,qa:dev,by:dev/);
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
    await page.locator(".label", { hasText: "Deployed · still to do" }).waitFor();
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
    await page.keyboard.press("Escape");
    if ((await page.locator(".filters .chip").count()) !== 2) throw new Error("no chips in merged view");
    await page.click(".seg button:has-text('tabs')");
    await page.locator(".role-tabs [role=tab]").nth(1).click();
    await page.waitForURL(/tab=1/);
    await page.screenshot({ path: out + "/board-tabs.png", fullPage: true });
    await page.goto(base + "/p/web/qa?f=qa:qa,qa:rio&view=tabs");
    await page.locator(".role-tabs [role=tab]", { hasText: "qa by rio" }).waitFor();
    await page.screenshot({ path: out + "/qa.png", fullPage: true });
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

  await step("narrow screens never scroll sideways", async () => {
    const mobile = await browser.newContext({ viewport: { width: 400, height: 860 } });
    await mobile.addCookies(await ctx.cookies());
    const mp = await mobile.newPage();
    for (const path of ["/p/web", "/p/web/i/export-invoices-as-csv", "/p/web/i/safari-login-fails-after-password-reset", "/p/web/qa", "/p/web/deploy", "/inbox"]) {
      await mp.goto(base + path);
      await mp.waitForTimeout(400);
      if (await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) throw new Error(path + " overflows");
    }
    await mp.goto(base + "/p/web/i/export-invoices-as-csv");
    await mp.screenshot({ path: out + "/item-mobile.png", fullPage: true });
    await mobile.close();
  });

  await browser.close();
  console.log("errors:", JSON.stringify(errors));
  process.exit(errors.length ? 1 : 0);
})();
