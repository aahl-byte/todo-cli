import { withBase } from "@/lib/base";
import { db } from "@/lib/db";
import { DISPLAY_COOKIE, displayAllowed, displayCookie } from "@/lib/display";

/** Trade the key in the link for a long-lived cookie, then show the board without the key in the URL. */
export async function GET(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const token = new URL(req.url).searchParams.get("key");
  if (!(await displayAllowed(await db(), key, token))) return new Response("That display key isn't valid for this project.", { status: 403 });
  const c = displayCookie((req.headers.get("x-forwarded-proto") ?? "http").split(",")[0].trim() === "https");
  const cookie = [`${DISPLAY_COOKIE}=${encodeURIComponent(token!)}`, `Path=${c.path}`, `Max-Age=${c.maxAge}`,
                  "HttpOnly", "SameSite=Lax", ...(c.secure ? ["Secure"] : [])].join("; ");
  return new Response(null, { status: 303, headers: { location: withBase(`/display/${encodeURIComponent(key)}`), "set-cookie": cookie } });
}
