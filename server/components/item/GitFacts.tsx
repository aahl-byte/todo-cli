// The item's git facts: where each branch landed, what it needs and what needs
// it, then the conflict and overlap hints. Derived from git; nothing here edits.
import type { BranchFact, Edge, GitFacts as Facts, Hint } from "@/lib/gitfacts";
import { withBase } from "@/lib/base";

const HINT = "whichever merges second merges the other in";
const STATE_TAG: Record<string, string> = { waiting: "hot", stale: "rej", landed: "" };

function ItemLink({ id, base }: { id?: string; base: string }) {
  return id ? <a href={withBase(`${base}/i/${id}`)}>{id}</a> : null;
}

function BranchRow({ b }: { b: BranchFact }) {
  return (
    <div className="rrow git-branch">
      <span className="grow mono" data-tip={b.head ? `head ${b.head.slice(0, 7)}` : undefined}>
        {b.name}{b.gone && <span className="faint"> (deleted)</span>}
      </span>
      {b.pr && <span className={`tag pr-${b.pr.state}`} data-tip={`→ ${b.pr.base ?? b.target}`}>#{b.pr.number} · {b.pr.state}</span>}
      {Object.entries(b.in ?? {}).map(([t, ok]) => (
        <span key={t} className={ok ? "git-in yes" : "git-in"} data-tip={ok ? `landed in ${t}` : `not in ${t}`}>in {t} {ok ? "✓" : "✗"}</span>
      ))}
    </div>
  );
}

function EdgeRow({ e, base }: { e: Edge; base: string }) {
  return (
    <div className="rrow git-edge">
      <span className={`tag ${STATE_TAG[e.state] ?? ""}`}>{e.state}</span>
      <span className="grow wrap">
        {e.id ? <ItemLink id={e.id} base={base} /> : <span className="mono">{e.needs}</span>}
        {e.branch && <span className="faint mono"> {e.branch}</span>}
        {e.evidence && <span className="faint"> — {e.evidence}</span>}
      </span>
    </div>
  );
}

function HintRow({ h, base }: { h: Hint; base: string }) {
  return (
    <div className="rrow">
      <span className="grow wrap"><ItemLink id={h.id} base={base} /><span className="faint mono"> {h.branch}</span>: {h.files.join(", ")}</span>
    </div>
  );
}

export function GitFacts({ facts, base }: { facts?: Facts; base: string }) {
  if (!facts) return null;
  const { branches = [], needs = [], needed_by = [], conflicts = [], overlaps = [] } = facts;
  if (!branches.length && !needs.length && !needed_by.length && !conflicts.length && !overlaps.length) return null;
  return (
    <section className="git-facts">
      <div className="label">Git</div>
      {branches.map((b) => <BranchRow key={b.name} b={b} />)}
      {needs.length > 0 && <div className="label sub">needs</div>}
      {needs.map((e, i) => <EdgeRow key={`n${i}`} e={e} base={base} />)}
      {needed_by.length > 0 && <div className="label sub">needed by</div>}
      {needed_by.map((e, i) => <EdgeRow key={`b${i}`} e={e} base={base} />)}
      {conflicts.length > 0 && <div className="label sub">conflicts with</div>}
      {conflicts.map((h, i) => <HintRow key={`c${i}`} h={h} base={base} />)}
      {overlaps.length > 0 && <div className="label sub">overlaps with</div>}
      {overlaps.map((h, i) => <HintRow key={`o${i}`} h={h} base={base} />)}
      {(conflicts.length > 0 || overlaps.length > 0) && <div className="faint git-hint">{HINT}</div>}
      {facts.notice && <div className="faint git-hint">{facts.notice}</div>}
    </section>
  );
}
