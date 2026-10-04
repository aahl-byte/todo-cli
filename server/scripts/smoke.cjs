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

(async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + "/login"); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 200)); });
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
    await page.waitForURL(/mine=1/);
    await page.click("button:has-text('Mine')");
    await page.waitForURL((u) => !u.search.includes("mine"));
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
    await page.click("button.add:has-text('+ comment')");
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
    await page.click("button.add:has-text('+ task')");
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
    await page.click("button.add:has-text('+ log')");
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

  await step("item: history shows a light and a time per entry", async () => {
    const rows = page.locator(".wide-only .hist .rrow");
    if ((await rows.count()) < 2) throw new Error("no history");
    if (await rows.first().locator(".ago").count() !== 1) throw new Error("no time");
  });

  await step("request: editable while triaging", async () => {
    await page.goto(item("safari-login-fails-after-password-reset"));
    await page.click("button.add:has-text('edit request')");
    await page.fill(".request textarea", "Safari 16 and 17 bounce back to /login after a password reset.");
    await page.click(".request button.primary");
    await page.locator(".request", { hasText: "16 and 17" }).waitFor();
  });

  await step("request: a later change goes back to triage", async () => {
    await page.goto(item("export-invoices-as-csv"));
    await page.click("button.add:has-text('change request')");
    await page.fill(".popup textarea", "Finance wants CSV and XLSX exports.");
    await page.click(".popup button.primary");
    await page.waitForFunction(() => document.querySelector(".head .stat-label")?.textContent === "in-triage");
    await page.locator(".request", { hasText: "XLSX" }).waitFor();
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

  await step("QA: reject needs a comment", async () => {
    await login("qa", "/p/web/qa");
    await page.screenshot({ path: out + "/qa.png", fullPage: true });
    const row = page.locator(".lrow", { hasText: "Maintenance banner" });
    await row.locator("button:has-text('Reject')").click();
    if (await page.locator(".popup button.danger").isEnabled()) throw new Error("reject without a comment allowed");
    await page.fill(".popup textarea", "Banner overlaps the nav on mobile");
    await page.click(".popup button.danger");
    await page.locator(".lrow", { hasText: "Maintenance banner" }).waitFor({ state: "detached" });
  });

  await step("deploy: pending checks need a confirmed force", async () => {
    await page.goto(base + "/p/web/deploy");
    await page.screenshot({ path: out + "/deploy.png", fullPage: true });
    await page.locator(".lrow", { hasText: "Store times in UTC" }).locator("button:has-text('Deployed')").click();
    await page.locator(".popup button.danger", { hasText: "Deploy anyway" }).click();
    await page.locator(".lrow", { hasText: "Store times in UTC" }).waitFor({ state: "detached" });
  });

  await step("inbox: rows open the item and mark read", async () => {
    await page.goto(base + "/inbox");
    const row = page.locator("a.lrow.unread").first();
    await row.waitFor();
    await row.click();
    await page.waitForURL(/\/p\/web\/i\//);
    await page.goto(base + "/inbox");
    await page.click("button:has-text('Mark all read')");
    await page.waitForFunction(() => !document.querySelector("a.lrow.unread"));
  });

  await step("new request lands on its item page", async () => {
    await login("pat", "/p/web/new");
    await page.fill("input[name=title]", "Dark mode for reports");
    await page.fill("textarea[name=description]", "Reports are unreadable at night.");
    await page.click("button:has-text('Submit')");
    await page.waitForURL(/\/i\/dark-mode-for-reports/);
    await page.locator(".request", { hasText: "unreadable at night" }).waitFor();
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
    for (const path of ["/p/web", "/p/web/i/export-invoices-as-csv", "/p/web/qa", "/inbox"]) {
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
