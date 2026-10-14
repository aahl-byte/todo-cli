import { db } from "@/lib/db";
import { pollLogin } from "@/lib/devices";
import { json } from "@/lib/http";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const code = typeof body?.device_code === "string" ? body.device_code : "";
  return json(await pollLogin(await db(), code));
}
