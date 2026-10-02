// UI smoke run against a seeded server: TOKENS=<seed-demo output> BASE_URL=… node scripts/smoke.cjs
// (seed with `TODO_PGLITE=<dir> npm run seed:demo > tokens.json`, then `npm start` on the same dir).
const { chromium } = require("playwright");
const tokens = JSON.parse(require("fs").readFileSync(process.env.TOKENS, "utf8"));
const base = process.env.BASE_URL || "http://127.0.0.1:3917";
const out = process.env.SHOTS || require("os").tmpdir();
const errors = [];
(async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + "/login"); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  const login = async (who) => {
    await ctx.clearCookies();
    await page.goto(base + "/login?next=/p/web");
    await page.fill('input[name=handle]', who);
    await page.fill('input[name=token]', tokens[who]);
    await page.click("button.primary");
    await page.waitForURL((u) => u.pathname.startsWith("/p/web"));
  };
  const step = async (name, fn) => { try { await fn(); console.log("ok  ", name); } catch (e) { console.log("FAIL", name, e.message.split("\n").slice(0, 8).join(" | ")); errors.push(name); } };

  await step("signed-out pages leak nothing", async () => {
    for (const path of ["/p/web", "/p/web/deploy", "/p/web/new", "/p/web/qa", "/inbox", "/p/web/i/store-times-in-utc"]) {
      const res = await fetch(base + path, { redirect: "manual" });
      const body = await res.text();
      if (res.status < 300 || res.status >= 400) throw new Error(`${path}: ${res.status}`);
      if (/convert timestamps|Store times|"dev"|Safari/.test(body)) throw new Error(`${path} leaked data`);
    }
  });
  await step("sign-in refuses an off-site redirect", async () => {
    await page.goto(base + "/login?next=//example.org/x");
    await page.fill('input[name=handle]', "dev");
    await page.fill('input[name=token]', tokens.dev);
    await page.click("button.primary");
    await page.waitForURL((u) => u.host === new URL(base).host && !u.pathname.startsWith("/login"));
  });
  await step("login as dev → board", () => login("dev"));
  await page.screenshot({ path: out + "/board.png", fullPage: true });
  await step("board shows columns", async () => {
    for (const t of ["Requested", "Triage", "In progress", "QA", "Ready to deploy"]) await page.getByRole("region", { name: t }).waitFor();
  });
  await step("needs-my-review filter", async () => {
    await page.click("text=Needs my review");
    await page.waitForURL(/review=1/);
    await page.getByText("Export invoices as CSV").waitFor();
    if (await page.getByText("Maintenance banner").count()) throw new Error("filter leaked");
  });
  await step("open item page", async () => {
    await page.goto(base + "/p/web/i/export-invoices-as-csv");
    await page.getByText("Phase 1", { exact: true }).first().waitFor();
    await page.getByText("Stream the CSV").waitFor();
  });
  await page.screenshot({ path: out + "/item.png", fullPage: true });
  await step("add a comment with mention", async () => {
    await page.fill('textarea[placeholder^="Comment"]', "@qa ready soon");
    await page.click('button:has-text("Comment")');
    await page.locator(".note", { hasText: "@qa ready soon" }).waitFor();
  });
  await step("change a task status", async () => {
    const row = page.locator(".task", { hasText: "download button" });
    await row.locator('select[aria-label="task status"]').selectOption("done");
    await page.waitForFunction(() => [...document.querySelectorAll(".task")].some((r) => r.textContent.includes("download button") && r.querySelector('select[aria-label="task status"]').value === "done"));
  });
  await step("hand to QA", async () => {
    await page.click('button:has-text("Ready for QA")');
    await page.locator(".pill", { hasText: "ready-for-qa" }).first().waitFor();
  });
  await step("ask a question", async () => {
    await page.fill('textarea[placeholder^="Ask a question"]', "Should the CSV include voided invoices?");
    await page.click('button:has-text("Ask")');
    await page.locator(".question", { hasText: "voided invoices" }).waitFor();
  });
  await step("stale write shows a banner", async () => {
    const p2 = await ctx.newPage();
    await p2.route("**/api/projects/*/changes*", (r) => r.abort());   // a tab that went stale
    await p2.goto(base + "/p/web/i/maintenance-banner");
    await page.goto(base + "/p/web/i/maintenance-banner");
    await page.click('button:has-text("Pick up")');
    await page.locator(".pill", { hasText: "in-qa" }).first().waitFor();
    await p2.click("text=Set status…");
    await p2.selectOption('select[aria-label="new status"]', "blocked");
    await p2.click('button:has-text("Set")');
    await p2.locator('.toasts .banner').waitFor();
    console.log("     banner:", await p2.locator('.toasts .banner').first().textContent());
    await p2.close();
  });
  await step("a live refresh updates an untouched select", async () => {
    await page.goto(base + "/p/web/i/export-invoices-as-csv");
    const v = await page.evaluate(() => document.querySelector("input[name=versions]").value);
    const ver = JSON.parse(v);
    const res = await fetch(base + "/api/projects/web/ops", { method: "POST",
      headers: { authorization: "Bearer " + tokens.qa, "content-type": "application/json" },
      body: JSON.stringify({ ops: [{ op_id: "prio-" + Date.now(), op: "set", entity: "item",
        uid: await page.evaluate(() => document.querySelector("input[name=uid]").value),
        item_uid: "x", data: { priority: "urgent" }, base: { priority: ver.priority } }] }) });
    if (!res.ok) throw new Error("push " + res.status);
    await page.waitForFunction(() => document.querySelector('select[aria-label="priority"]').value === "urgent", null, { timeout: 10000 });
  });
  await step("a refused write keeps the draft", async () => {
    const p3 = await ctx.newPage();
    await p3.route("**/api/projects/*/changes*", (r) => r.abort());
    await p3.goto(base + "/p/web/i/export-invoices-as-csv");
    await p3.fill('input[aria-label="title"]', "My draft title");
    await fetch(base + "/api/projects/web/ops", { method: "POST",
      headers: { authorization: "Bearer " + tokens.qa, "content-type": "application/json" },
      body: JSON.stringify({ ops: [{ op_id: "title-" + Date.now(), op: "set", entity: "item",
        uid: await p3.evaluate(() => document.querySelector("input[name=uid]").value), item_uid: "x",
        data: { title: "Renamed by QA" }, base: JSON.parse(await p3.evaluate(() => document.querySelector("input[name=versions]").value)) }] }) });
    await p3.click('button:has-text("Save")');
    await p3.locator(".toasts .banner").waitFor();
    if ((await p3.inputValue('input[aria-label="title"]')) !== "My draft title") throw new Error("draft lost");
    await p3.close();
  });
  await step("login as qa → QA queue, reject with comment", async () => {
    await login("qa");
    await page.goto(base + "/p/web/qa");
    await page.screenshot({ path: out + "/qa.png", fullPage: true });
    const row = page.locator(".list-row", { hasText: "Maintenance banner" });
    await row.locator("summary").click();
    await row.locator('textarea[name=text]').fill("Banner overlaps the nav on mobile");
    await row.locator('button:has-text("Reject")').click();
    await page.locator(".list-row", { hasText: "Maintenance banner" }).waitFor({ state: "detached" });
  });
  await step("rejection landed with its comment for the developer", async () => {
    await page.goto(base + "/p/web/i/maintenance-banner");
    await page.locator(".pill", { hasText: "in-progress" }).first().waitFor();
    await page.getByText("QA rejected ·").waitFor();
    await page.getByText("returned from QA ×1").waitFor();
  });
  await step("deploy board gates and forces", async () => {
    await page.goto(base + "/p/web/deploy");
    await page.screenshot({ path: out + "/deploy.png", fullPage: true });
    const btn = page.locator('button:has-text("Mark deployed")').first();
    if (!(await btn.isDisabled())) throw new Error("not gated");
    await page.locator('.check', { hasText: "convert timestamps" }).locator("button").first().click();
    await page.locator('.check', { hasText: "convert timestamps" }).getByText("☑").waitFor();
  });
  await step("inbox for qa shows mention and hand-off", async () => {
    await page.goto(base + "/inbox");
    await page.getByText("mentioned you").first().waitFor();
    await page.getByText("handed you QA").first().waitFor();
    await page.screenshot({ path: out + "/inbox.png", fullPage: true });
  });
  await step("login as pat → new request", async () => {
    await login("pat");
    await page.goto(base + "/p/web/new");
    await page.fill('input[name=title]', "Dark mode for reports");
    await page.fill('textarea[name=description]', "Reports are unreadable at night.");
    await page.click('button:has-text("Submit request")');
    await page.waitForURL(/\/i\/dark-mode-for-reports/);
    await page.getByText("Original request").waitFor();
  });
  await step("pat sees the dev's question in the inbox", async () => {
    await page.goto(base + "/inbox");
    await page.getByText("asked a question").first().waitFor();
  });
  await step("live refresh picks up another user's change", async () => {
    await page.goto(base + "/p/web");
    const before = await page.locator(".card", { hasText: "Dark mode for reports" }).count();
    const res = await fetch(base + "/api/projects/web/ops", { method: "POST", headers: { authorization: "Bearer " + tokens.dev, "content-type": "application/json" },
      body: JSON.stringify({ ops: [{ op_id: "smoke-" + Date.now(), op: "create", entity: "item", uid: "SMOKE" + Date.now(), item_uid: "x", data: { title: "Created by the API", created: new Date().toISOString() } }] }) });
    if (!res.ok) throw new Error("push " + res.status);
    await page.getByText("Created by the API").waitFor({ timeout: 10000 });
    if (!before) throw new Error("own card missing");
  });
  const mobile = await browser.newContext({ viewport: { width: 400, height: 860 } });
  const mp = await mobile.newPage();
  await mobile.addCookies((await ctx.cookies()));
  await mp.goto(base + "/p/web/i/export-invoices-as-csv");
  await mp.screenshot({ path: out + "/item-mobile.png", fullPage: true });
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  console.log(overflow ? "FAIL mobile horizontal overflow" : "ok   mobile no horizontal overflow");
  if (overflow) errors.push("mobile overflow");
  await browser.close();
  console.log("errors:", JSON.stringify(errors));
  process.exit(errors.length ? 1 : 0);
})();
