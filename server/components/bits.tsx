import { COMPLETE } from "@/lib/model";

export function StatusPill({ status }: { status: string }) {
  return <span className="pill" style={{ background: `var(--s-${status}, #888)` }}>{status}</span>;
}

export function Dot({ status }: { status: string }) {
  return <span className="dot" title={status} style={{ background: `var(--s-${status}, #888)` }} />;
}

export function TaskBar({ statuses }: { statuses: string[] }) {
  if (!statuses?.length) return null;
  const done = statuses.filter((s) => COMPLETE.includes(s)).length;
  return (
    <div className="taskbar" title={`${done}/${statuses.length} tasks complete`} aria-label={`${done} of ${statuses.length} tasks complete`}>
      {statuses.map((s, i) => <span key={i} style={{ background: `var(--s-${s}, #888)` }} />)}
    </div>
  );
}

export function Initials({ handle, label }: { handle?: string | null; label: string }) {
  if (!handle) return null;
  const short = handle.replace(/^jira:/, "").split(/[\s._-]+/).map((p) => p[0]?.toUpperCase()).join("").slice(0, 2);
  return <span className="mono" title={`${label}: ${handle}`}>{label[0]}:{short}</span>;
}

export function AiBadge({ via }: { via?: string | null }) {
  return via === "agent" ? <span className="ai" title="written by an agent">AI</span> : null;
}

export function when(ts?: string | null): string {
  if (!ts) return "";
  return String(ts).slice(0, 16).replace("T", " ");
}
