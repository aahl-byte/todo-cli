"use client";
// Shared controls in the watchtower drawer's idiom: status light, popover menu,
// popup, instant tooltip, click-to-edit text.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export function Led({ status, label = false }: { status: string; label?: boolean }) {
  return (
    <span className={`stat s-${status}`} data-tip={label ? undefined : status}>
      <span className="led" />
      {label && <span className="stat-label">{status}</span>}
    </span>
  );
}

export interface MenuOption {
  value: string;
  label?: ReactNode;
  hint?: string;
  /** Draw a divider above this option. */
  divider?: boolean;
}

/** A button that opens a keyboard-navigable listbox. */
export function Menu({ trigger, options, current, onPick, onOpen, label, disabled, className, tip }: {
  trigger: ReactNode;
  options: MenuOption[];
  current?: string | null;
  onPick: (value: string, e: { shiftKey: boolean }) => void;
  /** Called as the menu opens — the moment to pin the versions it acts on. */
  onOpen?: () => void;
  label: string;
  disabled?: boolean;
  className?: string;
  tip?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ x: number; y: number; up: boolean } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const estH = options.length * 26 + 10;
    const up = r.bottom + estH > window.innerHeight - 8;
    setPos({ x: Math.max(8, Math.min(r.left, window.innerWidth - 220)), y: up ? r.top - 4 : r.bottom + 4, up });
    setActive(Math.max(0, options.findIndex((o) => o.value === current)));
  }, [open, options, current]);

  useEffect(() => {
    if (!open || !pos) return;
    list.current?.focus();
    const away = (e: MouseEvent) => {
      if (!list.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    // Escape closes the menu wherever focus is.
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); btn.current?.focus(); }
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open, pos]);

  const pick = (i: number, shiftKey = false) => {
    setOpen(false);
    btn.current?.focus();
    if (options[i]) onPick(options[i].value, { shiftKey });
  };

  return (
    <>
      <button ref={btn} type="button" className={`menu-btn ${className ?? ""}`} aria-haspopup="listbox" aria-expanded={open}
              aria-label={label} disabled={disabled} data-tip={tip}
              onClick={() => setOpen((o) => { if (!o) onOpen?.(); return !o; })}>
        {trigger}
      </button>
      {open && pos && (
        <ul ref={list} role="listbox" tabIndex={-1} aria-label={label} className="menu"
            style={{ left: pos.x, ...(pos.up ? { bottom: window.innerHeight - pos.y } : { top: pos.y }) }}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); setOpen(false); btn.current?.focus(); }
              else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(options.length - 1, a + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
              else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(active); }
            }}>
          {options.map((o, i) => (
            <li key={o.value} role="option" aria-selected={o.value === current}
                className={`${i === active ? "active" : ""} ${o.value === current ? "current" : ""} ${o.divider ? "divider" : ""}`}
                onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => pick(i, e.shiftKey)}>
              <span className="menu-label">{o.label ?? o.value}</span>
              {o.hint && <span className="menu-hint">{o.hint}</span>}
              {o.value === current && <span className="menu-check">✓</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** A small modal for multi-field adds and confirmations. */
export function Popup({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>("input, textarea, select, button")?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="popup-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} className="popup" role="dialog" aria-modal="true" aria-label={title}>
        <div className="label">{title}</div>
        {children}
      </div>
    </div>
  );
}

/** Instant tooltips for any element carrying `data-tip`. Mounted once. */
export function Tooltips() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; up: boolean } | null>(null);
  useEffect(() => {
    const over = (e: MouseEvent) => {
      const el = (e.target as HTMLElement)?.closest?.("[data-tip]") as HTMLElement | null;
      if (!el || !el.dataset.tip) { setTip(null); return; }
      const r = el.getBoundingClientRect();
      const up = r.bottom + 40 > window.innerHeight;
      setTip({ text: el.dataset.tip, x: Math.min(r.left, window.innerWidth - 260), y: up ? r.top - 6 : r.bottom + 6, up });
    };
    const hide = () => setTip(null);
    document.addEventListener("mouseover", over);
    document.addEventListener("scroll", hide, true);
    document.addEventListener("mousedown", hide);
    return () => {
      document.removeEventListener("mouseover", over);
      document.removeEventListener("scroll", hide, true);
      document.removeEventListener("mousedown", hide);
    };
  }, []);
  if (!tip) return null;
  return (
    <div className="tip" role="tooltip" style={{ left: tip.x, ...(tip.up ? { bottom: window.innerHeight - tip.y } : { top: tip.y }) }}>
      {tip.text}
    </div>
  );
}

/** Text that turns into an input on click: Enter or blur saves, Esc cancels. */
export function EditableText({ value, onSave, onStart, label, className, multiline }: {
  value: string;
  onSave: (v: string) => void;
  /** Called as editing starts — the moment to pin the versions it acts on. */
  onStart?: () => void;
  label: string;
  className?: string;
  multiline?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const done = useRef(false);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    const v = draft.trim();
    if (v && v !== value) onSave(v);
  };
  if (!editing) {
    return (
      <button type="button" className={`edit-text ${className ?? ""}`} aria-label={`${label}: ${value}`}
              onClick={() => { done.current = false; onStart?.(); setEditing(true); }}>
        {value}
      </button>
    );
  }
  const common = {
    autoFocus: true, value: draft, "aria-label": label, className: `edit-input ${className ?? ""}`,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); done.current = true; setEditing(false); }
      else if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
    },
  };
  return multiline ? <textarea rows={4} {...common} /> : <input {...common} />;
}

/** "3h", "2d", "Sep 26" — the full local time goes in the tooltip. */
export function Ago({ ts }: { ts?: string | null }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => { setNow(Date.now()); const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const full = d.toLocaleString();
  let text = d.toISOString().slice(5, 10);
  if (now !== null) {
    const s = Math.max(0, (now - d.getTime()) / 1000);
    text = s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h`
      : s < 7 * 86400 ? `${Math.floor(s / 86400)}d` : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return <time className="ago" dateTime={ts} data-tip={full}>{text}</time>;
}

/** "Sep 26 14:03" in local time, for dev-log stamps. */
export function Stamp({ ts }: { ts?: string | null }) {
  const [text, setText] = useState("");
  useEffect(() => {
    if (!ts) return;
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return;
    setText(`${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${d.toTimeString().slice(0, 5)}`);
  }, [ts]);
  return <time className="stamp" dateTime={ts ?? undefined} data-tip={ts ?? undefined}>{text}</time>;
}
