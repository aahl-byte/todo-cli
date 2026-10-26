import Link from "next/link";
import { notFound } from "next/navigation";
import { DocView } from "@/components/DocView";
import { Ago } from "@/components/ui";
import { db } from "@/lib/db";
import { docByName, docKind, docPath, docRawPath, humanSize, RENDER_MAX_BYTES } from "@/lib/docs";
import { withBase } from "@/lib/base";
import { getObject } from "@/lib/files";
import { requireUser } from "@/lib/session";

const TEXTUAL = ["markdown", "html", "json", "code", "text"];

function decoded(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** One of an item's docs, rendered by its kind; view-only. */
export default async function DocPage({ params }: { params: Promise<{ key: string; id: string; name: string }> }) {
  const p = await params;
  const [key, id, name] = [p.key, decoded(p.id), decoded(p.name)];
  await requireUser();
  const d = await db();
  const [it] = await d.query("select uid, id, title from items where project = $1 and id = $2", [key, id]);
  const doc = it && (await docByName(d, key, it.uid, name));
  if (!doc) notFound();
  const kind = docKind(name);
  let text: string | null = null;
  if (TEXTUAL.includes(kind) && doc.size <= RENDER_MAX_BYTES) {
    const bytes = await getObject(doc.file_key);
    text = bytes ? new TextDecoder().decode(bytes) : "";
  }
  const download = withBase(docRawPath(key, doc.uid, true));
  return (
    <div className="doc-page">
      <div className="doc-head">
        <Link href={`/p/${encodeURIComponent(key)}/i/${encodeURIComponent(it.id)}`} className="faint">← {it.title}</Link>
        <h1 className="title">{name}</h1>
        <span className="faint">{humanSize(Number(doc.size))}{doc.by ? ` · ${doc.by}` : ""}{doc.via === "agent" ? " · AI" : ""}</span>
        <Ago ts={doc.at} />
        <a className="btn" href={download}>download</a>
      </div>
      <DocView name={name} kind={kind} text={text} raw={withBase(docRawPath(key, doc.uid))} download={download}
               docs={docPath(key, it.id, "").replace(/\/$/, "")} />
    </div>
  );
}
