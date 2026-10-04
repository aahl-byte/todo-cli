"use client";
// Board filters: two toggles and a popover; every change applies at once.
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Menu } from "./ui";

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
  const chips = [
    q.get("dev") && { k: "dev", text: `dev ${q.get("dev")}` },
    q.get("qa") && { k: "qa", text: `qa ${q.get("qa")}` },
    q.get("type") && { k: "type", text: q.get("type")! },
  ].filter(Boolean) as { k: string; text: string }[];
  const people = [{ value: "", label: "anyone" }, ...users.map((u) => ({ value: u }))];
  return (
    <div className="filters">
      <button type="button" className={`btn ${q.get("mine") === "1" ? "on" : ""}`} aria-pressed={q.get("mine") === "1"} onClick={() => toggle("mine")}>Mine</button>
      <button type="button" className={`btn ${q.get("review") === "1" ? "on" : ""}`} aria-pressed={q.get("review") === "1"} onClick={() => toggle("review")}>Needs my review</button>
      <Menu label="developer" className="btn" trigger={<>Dev<span className="caret">▾</span></>} current={q.get("dev") ?? ""} options={people} onPick={(v) => set("dev", v || null)} />
      <Menu label="QA" className="btn" trigger={<>QA<span className="caret">▾</span></>} current={q.get("qa") ?? ""} options={people} onPick={(v) => set("qa", v || null)} />
      <Menu label="type" className="btn" trigger={<>Type<span className="caret">▾</span></>} current={q.get("type") ?? ""}
            options={[{ value: "", label: "any" }, { value: "feature" }, { value: "bug" }]} onPick={(v) => set("type", v || null)} />
      <button type="button" className={`btn ${q.get("parked") === "1" ? "on" : ""}`} aria-pressed={q.get("parked") === "1"} onClick={() => toggle("parked")}>Parked</button>
      {chips.map((c) => (
        <span key={c.k} className="chip">{c.text}<button type="button" className="plus" aria-label={`clear ${c.k}`} onClick={() => set(c.k, null)}>×</button></span>
      ))}
    </div>
  );
}
