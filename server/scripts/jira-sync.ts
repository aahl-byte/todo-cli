// One read-only Jira sync pass, or one every N seconds with --every N.
export {};
process.env.JIRA_READ_ONLY = "1";
const { db } = await import("../lib/db");
const { syncJira } = await import("../lib/jira/sync");

const args = process.argv.slice(2);
const key = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--every");
const every = Number(args[args.indexOf("--every") + 1]) || 0;
if (!key) {
  console.error("usage: npm run jira:sync -- <project> [--every SECONDS] [--create-users]");
  process.exit(2);
}
const d = await db();
for (;;) {
  const started = Date.now();
  try {
    const r = await syncJira(d, key, { createUsers: args.includes("--create-users") });
    console.log(new Date().toISOString(), JSON.stringify(r), `${Date.now() - started}ms`);
  } catch (e) {
    console.error(new Date().toISOString(), (e as Error).message);
    if (!every) process.exit(1);
  }
  if (!every) break;
  await new Promise((r) => setTimeout(r, every * 1000));
}
await d.close?.();
process.exit(0);
