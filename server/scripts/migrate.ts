import { db, migrate } from "../lib/db";

const d = await db();
await migrate(d);
console.log("schema applied");
await (await db()).close?.();
process.exit(0);
