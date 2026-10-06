"use client";
// Board and QA-queue filters: role + person entries shown merged or as tabs,
// plus type, app and parked. Every change applies at once through the URL.
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { ITEM_TYPES } from "@/lib/model";
import { cookieQuery, filterCookie, filterPart, formatEntries, parseEntries, roleLabel, FILTER_KEYS, ROLES, SHARED_KEYS, type Entry, type Role } from "@/lib/filters";

export function RoleFilter({ users, apps, me, counts, review }: { users: string[]; apps: string[]; me: string; counts: number[]; review?: boolean }) {
  const router = useRouter();
  const path = usePathname();
  const q = useSearchParams();
  const entries = parseEntries(q.get("f"));
  const view = q.get("view") === "merged" ? "merged" : "tabs";
  const tab = Math.min(Number(q.get("tab") ?? 0) || 0, Math.max(entries.length - 1, 0));
  const project = decodeURIComponent(path.split("/")[2] ?? "");
  // Remember the filter for this project; pages without the board's own
  // toggles leave the remembered review/parked alone.
  const remember = (next: URLSearchParams) => {
    const name = filterCookie(project);
    const raw = document.cookie.split("; ").find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
    const out = new URLSearchParams(filterPart(new URLSearchParams(cookieQuery(raw))));
    for (const k of review ? FILTER_KEYS : SHARED_KEYS) { const v = next.get(k); if (v) out.set(k, v); else out.delete(k); }
    const value = out.toString();
    document.cookie = value
      ? `${name}=${encodeURIComponent(value)}; path=/; max-age=${30 * 86400}; samesite=lax`
      : `${name}=; path=/; max-age=0; samesite=lax`;
  };
  const go = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(q.toString());
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    remember(next);
    router.replace(`${path}${next.toString() ? `?${next}` : ""}`);
  };
  // A filtered link opened directly becomes the remembered filter.
  useEffect(() => { if (filterPart(q)) remember(new URLSearchParams(q.toString())); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const setEntries = (list: Entry[], extra: Record<string, string | null> = {}) => go({ f: formatEntries(list) || null, tab: null, ...extra });
  const mine: Entry[] = [{ role: "dev", who: me }, { role: "qa", who: me }, { role: "by", who: me }];
  const isMine = entries.length === 3 && mine.every((m) => entries.some((e) => e.role === m.role && e.who === m.who));

  const pop = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => { if (pop.current?.open && !pop.current.contains(e.target as Node)) pop.current.open = false; };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && pop.current?.open) { pop.current.open = false; pop.current.querySelector("summary")?.focus(); } };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, []);

  const label = (e: Entry) => `${roleLabel(e.role)} ${e.who === me ? "me" : e.who}`;
  return (
    <>
      <div className="filters">
        <button type="button" className={`btn ${isMine ? "on" : ""}`} aria-pressed={isMine}
                onClick={() => setEntries(isMine ? [] : mine, { view: isMine ? null : "merged" })}>Mine</button>
        {review && (
          <button type="button" className={`btn ${q.get("review") === "1" ? "on" : ""}`} aria-pressed={q.get("review") === "1"}
                  onClick={() => go({ review: q.get("review") === "1" ? null : "1" })}>Needs my review</button>
        )}
        <details ref={pop} className="switcher filter">
          <summary className="btn">Filter<span className="caret">▾</span></summary>
          <div className="menu form role-filter">
            {entries.map((e, i) => (
              <div key={i} className="row entry-row">
                <select aria-label="role" value={e.role}
                        onChange={(ev) => setEntries(entries.map((x, j) => (j === i ? { ...x, role: ev.target.value as Role } : x)))}>
                  {ROLES.map((r) => <option key={r.role} value={r.role}>{r.label}</option>)}
                </select>
                <select aria-label="person" value={e.who}
                        onChange={(ev) => setEntries(entries.map((x, j) => (j === i ? { ...x, who: ev.target.value } : x)))}>
                  {users.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
                <button type="button" className="x" aria-label={`remove ${label(e)}`} onClick={() => setEntries(entries.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
            <button type="button" className="add" onClick={() => setEntries([...entries, { role: "dev", who: users.find((u) => !entries.some((e) => e.role === "dev" && e.who === u)) ?? me }])}>
              <span className="pl" aria-hidden="true">+</span>add
            </button>
            <label className="k">type
              <select value={q.get("type") ?? ""} onChange={(e) => go({ type: e.target.value || null })}>
                <option value="">any</option>{ITEM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            {apps.length > 0 && (
              <label className="k">app
                <select value={q.get("app") ?? ""} onChange={(e) => go({ app: e.target.value || null })}>
                  <option value="">any</option>{apps.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </label>
            )}
            {review && <label className="check"><input type="checkbox" checked={q.get("parked") === "1"} onChange={() => go({ parked: q.get("parked") === "1" ? null : "1" })} /> show parked</label>}
          </div>
        </details>
        {entries.length > 1 && (
          <span className="seg" role="group" aria-label="view">
            <button type="button" className={`btn ${view === "merged" ? "on" : ""}`} aria-pressed={view === "merged"} onClick={() => go({ view: "merged", tab: null })}>merged</button>
            <button type="button" className={`btn ${view === "tabs" ? "on" : ""}`} aria-pressed={view === "tabs"} onClick={() => go({ view: null, tab: null })}>tabs</button>
          </span>
        )}
        {(view === "merged" || entries.length === 1) && entries.map((e, i) => (
          <span key={i} className="chip">{label(e)}<button type="button" className="x" aria-label={`clear ${label(e)}`} onClick={() => setEntries(entries.filter((_, j) => j !== i))}>×</button></span>
        ))}
        {q.get("type") && <span className="chip">{q.get("type")}<button type="button" className="x" aria-label="clear type" onClick={() => go({ type: null })}>×</button></span>}
        {q.get("app") && <span className="chip">app {q.get("app")}<button type="button" className="x" aria-label="clear app" onClick={() => go({ app: null })}>×</button></span>}
      </div>
      {view === "tabs" && entries.length > 1 && (
        <div className="tabs role-tabs" role="tablist">
          {entries.map((e, i) => (
            <button key={i} role="tab" aria-selected={i === tab} className={`tab ${i === tab ? "on" : ""}`} onClick={() => go({ tab: i ? String(i) : null })}>
              {label(e)}<span className="n">{counts[i] ?? 0}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
