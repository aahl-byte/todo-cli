// One read-only Jira sync pass, or one every N seconds with --every N. --all
// polls every project in `links` mode in turn.
export {};
process.env.JIRA_READ_ONLY = "1";
const { db } = await import("../lib/db");
const { linkedProjects, syncJira } = await import("../lib/jira/sync");

const args = process.argv.slice(2);
const key = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--every");
const every = Number(args[args.indexOf("--every") + 1]) || 0;
const all = args.includes("--all");
if (!key === !all) {
  console.error("usage: npm run jira:sync -- <project> | --all [--every SECONDS] [--create-users]");
  process.exit(2);
}
const d = await db();
for (;;) {
  let failed = false;
  for (const project of all ? await linkedProjects(d) : [key!]) {
    const started = Date.now();
    try {
      const r = await syncJira(d, project, { createUsers: args.includes("--create-users") });
      console.log(new Date().toISOString(), project, JSON.stringify(r), `${Date.now() - started}ms`);
    } catch (e) {
      console.error(new Date().toISOString(), project, (e as Error).message);
      failed = true;
    }
  }
  if (!every) {
    await d.close?.();
    process.exit(failed ? 1 : 0);
  }
  await new Promise((r) => setTimeout(r, every * 1000));
}
