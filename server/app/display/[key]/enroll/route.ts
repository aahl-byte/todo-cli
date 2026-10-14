import { withBase } from "@/lib/base";
import { db } from "@/lib/db";
import { DISPLAY_COOKIE, displayAllowed } from "@/lib/display";

const YEAR = 60 * 60 * 24 * 365;

/** Trade the key in the link for a long-lived cookie, then show the board without the key in the URL. */
export async function GET(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const token = new URL(req.url).searchParams.get("key");
  if (!(await displayAllowed(await db(), key, token))) return new Response("That display key isn't valid for this project.", { status: 403 });
  const https = (req.headers.get("x-forwarded-proto") ?? "http").split(",")[0].trim() === "https";
  const cookie = [`${DISPLAY_COOKIE}=${encodeURIComponent(token!)}`, `Path=${withBase("/display/")}`, `Max-Age=${YEAR}`,
                  "HttpOnly", "SameSite=Lax", ...(https ? ["Secure"] : [])].join("; ");
  return new Response(null, { status: 303, headers: { location: withBase(`/display/${encodeURIComponent(key)}`), "set-cookie": cookie } });
}
