// Turning what a plugin asks to attach into a checked Attachment with a stable key.
import type { Attachment, AttachmentKind } from "./types";

/** Each kind's fields: required ones first, and the one its default key comes from. */
export const ATTACH_FIELDS: Record<AttachmentKind, { required: string[]; optional: string[]; keyFrom: string }> = {
  link: { required: ["type", "url"], optional: ["label"], keyFrom: "url" },
  edge: { required: ["needs", "because"], optional: ["in"], keyFrom: "needs" },
  doc: { required: ["name"], optional: ["content", "url"], keyFrom: "name" },
  log: { required: ["text"], optional: [], keyFrom: "text" },
  request: { required: ["text"], optional: [], keyFrom: "text" },
};

const NEEDS = /^(item:|branch:)\S|^https?:\/\//;

export class AttachError extends Error {}

function asText(v: unknown, pretty = false): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  return pretty ? JSON.stringify(v, null, 2) : JSON.stringify(v);
}

/** log and request take a bare string as their text. */
export function attachFields(kind: AttachmentKind, raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") return { text: raw };
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

export function makeAttachment(kind: AttachmentKind, raw: unknown, key?: unknown): Attachment {
  const spec = ATTACH_FIELDS[kind];
  const fields = attachFields(kind, raw);
  const out: Record<string, string> = {};
  for (const f of [...spec.required, ...spec.optional]) {
    const v = asText(fields[f], kind === "doc" && f === "content");
    if (v !== undefined && v !== "") out[f] = v;
  }
  for (const f of spec.required) if (!out[f]) throw new AttachError(`${kind} has no ${f}`);
  if (kind === "link" && !/^https?:\/\//i.test(out.url)) throw new AttachError(`link url isn't http(s): ${out.url}`);
  if (kind === "edge" && !NEEDS.test(out.needs)) throw new AttachError(`edge needs item:<id>, branch:<name> or a PR URL, not ${out.needs}`);
  const given = asText(key);
  return { kind, key: given || `${kind}:${out[spec.keyFrom]}`, ...out } as Attachment;
}

/** The first attachment per key, logging any later duplicates. */
export function uniqueByKey(attached: Attachment[], log: string[]): Attachment[] {
  const seen = new Set<string>();
  return attached.filter((a) => {
    if (seen.has(a.key)) {
      log.push(`dropped a second ${a.kind} with key ${a.key}`);
      return false;
    }
    seen.add(a.key);
    return true;
  });
}
