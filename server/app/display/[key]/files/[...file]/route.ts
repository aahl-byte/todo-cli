import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { DISPLAY_COOKIE, displayFor } from "@/lib/display";
import { fileResponse, inProject, KEY_RE } from "@/lib/files";

type Params = { params: Promise<{ key: string; file: string[] }> };

/** A stored image of this project, for a signed-in display. */
export async function GET(_req: Request, { params }: Params) {
  const { key: project, file } = await params;
  const key = file.join("/");
  if (!(await displayFor(await db(), project, (await cookies()).get(DISPLAY_COOKIE)?.value))) return new Response(null, { status: 401 });
  if (!KEY_RE.test(key) || !inProject(key, project)) return new Response(null, { status: 404 });
  return fileResponse(key);
}
