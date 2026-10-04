// Browser side of image uploads: ask the server where, send the file there,
// and return the Markdown that shows it.
export async function uploadImage(file: File, project: string, scope: string): Promise<string> {
  const res = await fetch("/api/files", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ project, scope, type: file.type, size: file.size }),
  });
  const target = await res.json();
  if (!res.ok) throw new Error(target.error ?? "upload refused");
  const fd = new FormData();
  for (const [k, v] of Object.entries(target.fields as Record<string, string>)) fd.append(k, v);
  fd.append("file", file);
  const put = await fetch(target.url, { method: "POST", body: fd });
  if (!put.ok) throw new Error("upload failed");
  const alt = file.name.replace(/[[\]]/g, "") || "image";
  return `![${alt}](/api/files/${target.key})`;
}

export const images = (files: FileList | File[]) => [...files].filter((f) => f.type.startsWith("image/"));

/** Upload pasted or dropped images into a text field: a placeholder goes in at
 * the cursor at once and becomes the image link when the upload finishes. */
export async function insertImages(files: FileList | File[], at: number, field: {
  project: string; scope: string; get: () => string; set: (text: string) => void; error: (message: string) => void;
}): Promise<boolean> {
  const list = images(files);
  if (!list.length) return false;
  for (const f of list) {
    const mark = `![uploading ${f.name.replace(/[[\]]/g, "")}…]()`;
    const text = field.get();
    const pos = Math.min(at, text.length);
    const lead = pos > 0 && text[pos - 1] !== "\n" ? "\n" : "";
    field.set(text.slice(0, pos) + lead + mark + "\n" + text.slice(pos));
    at = pos + lead.length + mark.length + 1;
    try {
      const md = await uploadImage(f, field.project, field.scope);
      field.set(field.get().replace(mark, md));
    } catch (e) {
      field.set(field.get().replace(mark + "\n", ""));
      field.error((e as Error).message);
    }
  }
  return true;
}
