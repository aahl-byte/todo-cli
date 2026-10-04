"use client";
// A Markdown textarea with @mention autocomplete and image paste/drop upload.
import { useRef, useState } from "react";
import { images, insertImages } from "@/lib/upload-client";

export function Composer({ name = "text", users, placeholder, required, uploads, rows = 3, autoFocus }: {
  name?: string;
  users: string[];
  placeholder?: string;
  required?: boolean;
  uploads?: { project: string; scope: string } | null;
  rows?: number;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onInput = () => {
    const el = ref.current!;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
    const before = el.value.slice(0, el.selectionStart);
    const m = /(?:^|\s)@([\w.-]*)$/.exec(before);
    setQuery(m ? m[1] : null);
  };

  const pick = (handle: string) => {
    const el = ref.current!;
    const pos = el.selectionStart;
    const before = el.value.slice(0, pos).replace(/@([\w.-]*)$/, `@${handle} `);
    el.value = before + el.value.slice(pos);
    el.focus();
    el.selectionStart = el.selectionEnd = before.length;
    setQuery(null);
  };

  const upload = (files: FileList | File[]) => {
    const el = ref.current!;
    if (!uploads || !images(files).length) return false;
    setBusy(true);
    void insertImages(files, el.selectionStart, {
      project: uploads.project, scope: uploads.scope, get: () => el.value,
      set: (v) => { el.value = v; onInput(); }, error: setError,
    }).finally(() => setBusy(false));
    return true;
  };

  const matches = query === null ? [] : users.filter((u) => u.toLowerCase().startsWith(query.toLowerCase())).slice(0, 6);
  return (
    <div style={{ position: "relative" }}>
      <textarea ref={ref} name={name} rows={rows} placeholder={placeholder} aria-label={placeholder ?? name} required={required} onInput={onInput} autoFocus={autoFocus}
        onPaste={(e) => { if (upload(e.clipboardData.files)) e.preventDefault(); }}
        onDrop={(e) => { if (upload(e.dataTransfer.files)) e.preventDefault(); }} />
      {matches.length > 0 && (
        <div className="suggest">
          {matches.map((u) => <button type="button" key={u} onMouseDown={(e) => { e.preventDefault(); pick(u); }}>@{u}</button>)}
        </div>
      )}
      {busy && <div className="muted">uploading…</div>}
      {error && <div className="hot" role="alert">{error}</div>}
    </div>
  );
}
