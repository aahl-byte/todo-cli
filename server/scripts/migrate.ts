import { db, migrate } from "../lib/db";

const d = await db();
await migrate(d);
console.log("schema applied");
process.exit(0);
