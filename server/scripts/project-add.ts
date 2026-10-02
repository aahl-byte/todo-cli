import { addProject } from "../lib/auth";
import { db } from "../lib/db";

const [key, name] = process.argv.slice(2);
if (!key) {
  console.error("usage: npm run project:add -- <key> [name]");
  process.exit(2);
}
await addProject(await db(), key, name);
console.log(`project ${key} ready`);
process.exit(0);
