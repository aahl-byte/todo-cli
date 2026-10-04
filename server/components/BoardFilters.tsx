"use client";
// Board filters: two toggles and a popover; every change applies at once.
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

export function BoardFilters({ users }: { users: string[] }) {
  const router = useRouter();
  const path = usePathname();
  const q = useSearchParams();
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(q.toString());
    if (v) next.set(k, v); else next.delete(k);
    router.replace(`${path}${next.toString() ? `?${next}` : ""}`);
  };
  const toggle = (k: string) => set(k, q.get(k) === "1" ? null : "1");
  const pop = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => { if (pop.current?.open && !pop.current.contains(e.target as Node)) pop.current.open = false; };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && pop.current?.open) { pop.current.open = false; pop.current.querySelector("summary")?.focus(); } };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, []);
  const chips = [
    q.get("dev") && { k: "dev", text: `dev ${q.get("dev")}` },
    q.get("qa") && { k: "qa", text: `qa ${q.get("qa")}` },
    q.get("type") && { k: "type", text: q.get("type")! },
    q.get("parked") === "1" && { k: "parked", text: "parked" },
  ].filter(Boolean) as { k: string; text: string }[];
  const people: { value: string; label?: string }[] = [{ value: "", label: "anyone" }, ...users.map((u) => ({ value: u }))];
  return (
    <div className="filters">
      <button type="button" className={`btn ${q.get("mine") === "1" ? "on" : ""}`} aria-pressed={q.get("mine") === "1"} onClick={() => toggle("mine")}>Mine</button>
      <button type="button" className={`btn ${q.get("review") === "1" ? "on" : ""}`} aria-pressed={q.get("review") === "1"} onClick={() => toggle("review")}>Needs my review</button>
      <details ref={pop} className="switcher filter">
        <summary className="btn">Filter<span className="caret">▾</span></summary>
        <div className="menu form">
          <label className="k">developer
            <select value={q.get("dev") ?? ""} onChange={(e) => set("dev", e.target.value || null)}>{people.map((p) => <option key={p.value} value={p.value}>{p.label ?? p.value}</option>)}</select>
          </label>
          <label className="k">QA
            <select value={q.get("qa") ?? ""} onChange={(e) => set("qa", e.target.value || null)}>{people.map((p) => <option key={p.value} value={p.value}>{p.label ?? p.value}</option>)}</select>
          </label>
          <label className="k">type
            <select value={q.get("type") ?? ""} onChange={(e) => set("type", e.target.value || null)}>
              <option value="">any</option><option value="feature">feature</option><option value="bug">bug</option>
            </select>
          </label>
          <label className="check"><input type="checkbox" checked={q.get("parked") === "1"} onChange={() => toggle("parked")} /> show parked</label>
        </div>
      </details>
      {chips.map((c) => (
        <span key={c.k} className="chip">{c.text}<button type="button" className="plus" aria-label={`clear ${c.k}`} onClick={() => set(c.k, null)}>×</button></span>
      ))}
    </div>
  );
}
