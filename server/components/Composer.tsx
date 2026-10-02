"use client";
// A Markdown textarea with @mention autocomplete and image paste/drop upload.
import { useRef, useState } from "react";

export function Composer({ name = "text", users, placeholder, required, uploads, rows = 3 }: {
  name?: string;
  users: string[];
  placeholder?: string;
  required?: boolean;
  uploads?: boolean;
  rows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onInput = () => {
    const el = ref.current!;
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

  const upload = async (files: FileList | File[]) => {
    const images = [...files].filter((f) => f.type.startsWith("image/"));
    if (!images.length || !uploads) return false;
    setBusy(true);
    try {
      for (const f of images) {
        const fd = new FormData();
        fd.append("file", f);
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        if (!res.ok) continue;
        const { url } = await res.json();
        const el = ref.current!;
        el.value += `${el.value && !el.value.endsWith("\n") ? "\n" : ""}![${f.name}](${url})\n`;
      }
    } finally {
      setBusy(false);
    }
    return true;
  };

  const matches = query === null ? [] : users.filter((u) => u.toLowerCase().startsWith(query.toLowerCase())).slice(0, 6);
  return (
    <div style={{ position: "relative" }}>
      <textarea ref={ref} name={name} rows={rows} placeholder={placeholder} aria-label={placeholder ?? name} required={required} onInput={onInput}
        onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); void upload(e.clipboardData.files); } }}
        onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); void upload(e.dataTransfer.files); } }} />
      {matches.length > 0 && (
        <div className="suggest">
          {matches.map((u) => <button type="button" key={u} onMouseDown={(e) => { e.preventDefault(); pick(u); }}>@{u}</button>)}
        </div>
      )}
      {busy && <div className="muted">uploading…</div>}
    </div>
  );
}
