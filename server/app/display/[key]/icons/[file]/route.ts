import { readFile } from "node:fs/promises";
import path from "node:path";

// The app's icons, served again under the display's path so an installed
// display can fetch them without signing in.
const ICONS: Record<string, string> = {
  "icon.svg": "image/svg+xml",
  "icon-192.png": "image/png",
  "icon-512.png": "image/png",
  "icon-maskable-512.png": "image/png",
  "apple-touch-icon.png": "image/png",
};

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const type = ICONS[file];
  if (!type) return new Response(null, { status: 404 });
  const body = await readFile(path.join(process.cwd(), "public", file));
  return new Response(body, { headers: { "content-type": type, "cache-control": "public, max-age=86400" } });
}
