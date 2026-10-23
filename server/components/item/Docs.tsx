"use client";
// The item's docs: each opens rendered on its own page. Upload adds docs (or
// replaces one of the same name); each doc can be replaced or deleted. Bytes
// go straight to the upload target; the server records them.
import { useRef, useState } from "react";
import * as act from "@/app/doc-actions";
import { withBase } from "@/lib/base";
import { docPath, humanSize } from "@/lib/doc-view";
import { useReadOnly } from "../ReadOnly";
import { notify } from "../Toaster";
import { Ago } from "../ui";
import { Remove, report, type Ctx } from "./ItemView";

type Row = Record<string, any>;

async function send(ctx: Ctx, file: File, name: string, base: string | null): Promise<boolean> {
  const target = await act.docUploadTarget({ project: ctx.project, itemUid: ctx.itemUid, name, size: file.size });
  if (!report(target)) return false;
  const fd = new FormData();
  for (const [k, v] of Object.entries(target.fields ?? {})) fd.append(k, v);
  fd.append("file", file);
  const put = await fetch(target.url!, { method: "POST", body: fd }).catch(() => null);
  if (!put?.ok) {
    notify(`Upload of ${name} failed.`);
    return false;
  }
  return report(await act.saveDoc({ project: ctx.project, itemUid: ctx.itemUid, name, key: target.key!, base }));
}

export function Docs({ rows, ctx, itemId }: { rows: Row[]; ctx: Ctx; itemId: string }) {
  const readOnly = useReadOnly();
  const [busy, setBusy] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const writable = !readOnly && ctx.uploads;
  if (!rows.length && !writable) return null;

  const upload = async (files: FileList | null, as?: Row) => {
    for (const f of [...(files ?? [])]) {
      const name = as?.name ?? f.name;
      setBusy(name);
      await send(ctx, f, name, (as ?? rows.find((r) => r.name === name))?.sha256 ?? null);
    }
    setBusy(null);
  };

  return (
    <section className="docs">
      <div className="label">
        Docs{rows.length > 0 && <span className="n">{rows.length}</span>}
        {writable && (
          <>
            <button type="button" className="plus" aria-label="upload docs" data-tip="upload docs (a doc of the same name is replaced)"
                    disabled={!!busy} onClick={() => picker.current?.click()}>+</button>
            <input ref={picker} type="file" multiple hidden onChange={(e) => { void upload(e.target.files); e.target.value = ""; }} />
          </>
        )}
      </div>
      {busy && <div className="faint doc-busy">uploading {busy}…</div>}
      <ul className="doc-list">
        {rows.map((d) => (
          <li key={d.uid} className="rrow doc-row">
            <span className="tag">{String(d.name).includes(".") ? String(d.name).split(".").pop()!.slice(0, 5) : "file"}</span>
            {readOnly
              ? <span className="grow">{d.name}</span>
              : <a className="grow" href={withBase(docPath(ctx.project, itemId, d.name))}>{d.name}</a>}
            <span className="faint">{humanSize(Number(d.size))}{d.by ? ` · ${d.by}` : ""}</span>
            <Ago ts={d.at} />
            {writable && <Replace row={d} disabled={!!busy} onPick={(files) => void upload(files, d)} />}
            {writable && <Remove onConfirm={() => act.deleteDoc({ project: ctx.project, uid: d.uid, name: d.name, base: d.sha256 })} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Replace({ row, disabled, onPick }: { row: Row; disabled: boolean; onPick: (files: FileList | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="x" aria-label={`replace ${row.name}`} data-tip="replace with another file"
              disabled={disabled} onClick={() => input.current?.click()}>⇅</button>
      <input ref={input} type="file" hidden onChange={(e) => { onPick(e.target.files); e.target.value = ""; }} />
    </>
  );
}
