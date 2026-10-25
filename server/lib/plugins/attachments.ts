// Turning what a plugin asks to attach into a checked Attachment with a stable key.
import { bytes, LimitError } from "./limits";
import { MAX_DOC_CONTENT, MAX_FIELD, type Attachment, type AttachmentKind } from "./types";

/** Each kind's fields: required ones first, and the ones its default key comes from. */
export const ATTACH_FIELDS: Record<AttachmentKind, { required: string[]; optional: string[]; keyFrom: string[] }> = {
  link: { required: ["type", "url"], optional: ["label"], keyFrom: ["url"] },
  edge: { required: ["needs", "because"], optional: ["in"], keyFrom: ["needs", "in"] },
  doc: { required: ["name"], optional: ["content", "url"], keyFrom: ["name"] },
  log: { required: ["text"], optional: [], keyFrom: ["text"] },
  request: { required: ["text"], optional: [], keyFrom: ["text"] },
};

const NEEDS = /^(item:|branch:)\S|^https?:\/\//;

/** A malformed attachment: YAML plugins skip it, code plugins see it thrown. */
export class AttachError extends Error {}

function asText(v: unknown, pretty = false): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  return pretty ? JSON.stringify(v, null, 2) : JSON.stringify(v);
}

/** log and request take a bare string as their text. */
export function attachFields(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") return { text: raw };
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

const article = (kind: string) => (kind === "edge" ? "an" : "a");

export function makeAttachment(kind: AttachmentKind, raw: unknown, key?: unknown): Attachment {
  const spec = ATTACH_FIELDS[kind];
  const fields = attachFields(raw);
  const out: Record<string, string> = {};
  for (const f of [...spec.required, ...spec.optional]) {
    const content = kind === "doc" && f === "content";
    const v = asText(fields[f], content);
    if (v === undefined || v === "") continue;
    if (content ? bytes(v) > MAX_DOC_CONTENT : bytes(v) > MAX_FIELD) {
      throw new LimitError(`${article(kind)} ${kind}'s ${f} is longer than ${content ? "1 MB" : `${MAX_FIELD / 1024} KB`}`);
    }
    out[f] = v;
  }
  for (const f of spec.required) if (!out[f]) throw new AttachError(`${kind} has no ${f}`);
  if (kind === "link" && !/^https?:\/\//i.test(out.url)) throw new AttachError(`link url isn't http(s): ${out.url}`);
  if (kind === "edge" && !NEEDS.test(out.needs)) throw new AttachError(`edge needs item:<id>, branch:<name> or a PR URL, not ${out.needs}`);
  const given = asText(key);
  if (given && bytes(given) > MAX_FIELD) throw new LimitError(`${article(kind)} ${kind}'s key is longer than ${MAX_FIELD / 1024} KB`);
  const derived = `${kind}:${out[spec.keyFrom[0]]}${spec.keyFrom.slice(1).map((f) => (out[f] ? ` ${f} ${out[f]}` : "")).join("")}`;
  return { kind, key: given || derived, ...out } as Attachment;
}
