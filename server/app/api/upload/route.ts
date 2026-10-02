import { authed, json } from "@/lib/http";
import { ulid } from "@/lib/ulid";

const MAX_BYTES = 10 * 1024 * 1024;

// Pasted or dropped images go to Vercel Blob; the composer inserts the URL.
export async function POST(req: Request) {
  const a = await authed(req);
  if (a instanceof Response) return a;
  if (!process.env.BLOB_READ_WRITE_TOKEN) return json({ error: "uploads need a Vercel Blob store" }, 501);
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File) || !file.type.startsWith("image/")) return json({ error: "send one image as `file`" }, 400);
  if (file.size > MAX_BYTES) return json({ error: "images are limited to 10 MB" }, 413);
  const { put } = await import("@vercel/blob");
  const safe = file.name.replace(/[^\w.-]+/g, "_").slice(-80) || "image";
  const blob = await put(`uploads/${ulid()}-${safe}`, file, { access: "public", contentType: file.type });
  return json({ url: blob.url });
}
