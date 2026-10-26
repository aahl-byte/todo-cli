// The unresolved dependencies a stage or deploy waits on, listed in the move
// dialog with what each waits on and why.
import { withBase } from "@/lib/base";
import type { WaitLine } from "@/lib/waits";

const STATE_TAG: Record<string, string> = { waiting: "hot", stale: "rej", unknown: "rej" };

export function WaitList({ waits, project }: { waits: WaitLine[]; project: string }) {
  return (
    <ul className="wait-list">
      {waits.map((w, i) => (
        <li key={i} className="rrow git-edge">
          <span className={`tag ${STATE_TAG[w.state] ?? ""}`}>{w.state}</span>
          <span className="grow wrap">
            {w.item ? <a href={withBase(`/p/${project}/i/${w.item}`)}>{w.item}</a> : <span className="mono">{w.needs}</span>}
            {w.branch && <span className="faint mono"> {w.branch}</span>}
            {w.why && <span className="faint"> — {w.why}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

const count = (n: number) => `${n} unresolved dependenc${n === 1 ? "y" : "ies"}`;

/** The dialog's question for a forced stage or deploy: what's still pending. */
export function forceTitle(to: string, waits: number, pendingChecks: number): string {
  const what = [pendingChecks ? `${pendingChecks} pre-deploy check${pendingChecks === 1 ? "" : "s"} pending` : null, waits ? count(waits) : null]
    .filter(Boolean).join(" and ");
  return `${to === "deployed" ? "Deploy" : "Stage"} with ${what}?`;
}
