"use client";
// A timestamp shown in the viewer's own time zone.
import { useEffect, useState } from "react";

export function Time({ ts }: { ts?: string | null }) {
  const [text, setText] = useState(() => (ts ? String(ts).slice(0, 16).replace("T", " ") + " UTC" : ""));
  useEffect(() => {
    if (!ts) return;
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) {
      setText(d.toLocaleString(undefined, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }));
    }
  }, [ts]);
  return <time dateTime={ts ?? undefined}>{text}</time>;
}
