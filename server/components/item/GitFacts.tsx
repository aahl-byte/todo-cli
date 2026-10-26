// The item's git facts: where each branch landed, what it needs and what needs
// it, the branches it shares unlanded commits with, then the conflict and
// overlap hints. Derived from git; nothing here edits.
import type { BranchFact, Edge, GitFacts as Facts, Hint, Share } from "@/lib/gitfacts";
import { withBase } from "@/lib/base";
import { PluginBy } from "./PluginBy";

const STATE_TAG: Record<string, string> = { waiting: "hot", stale: "rej", unknown: "rej", landed: "" };
const MARK = (ok: boolean | null | undefined) => (ok === true ? "✓" : ok === false ? "✗" : "?");

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
        <span key={t} className={ok ? "git-in yes" : "git-in"} data-tip={ok ? `landed in ${t}` : ok === false ? `not in ${t}` : `can't tell about ${t}`}>in {t} {MARK(ok)}</span>
      ))}
      {b.unknown && <span className="tag rej" data-tip={b.unknown}>unknown</span>}
    </div>
  );
}

function EdgeRow({ e, base, by }: { e: Edge; base: string; by?: string }) {
  return (
    <div className="rrow git-edge">
      <span className={`tag ${STATE_TAG[e.state] ?? ""}`} data-tip={e.reason}>{e.state}</span>
      <span className="grow wrap">
        {e.id ? <ItemLink id={e.id} base={base} /> : <span className="mono">{e.needs}</span>}
        {e.branch && <span className="faint mono"> {e.branch}</span>}
        {e.evidence && <span className="faint"> — {e.evidence}</span>}
        {e.reason && <span className="faint"> ({e.reason})</span>}
        {e.cycle && <span className="faint"> — {e.cycle}</span>}
      </span>
      <PluginBy by={by} />
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

function ShareRow({ s, base }: { s: Share; base: string }) {
  return (
    <div className="rrow">
      {s.state === "unknown" && <span className="tag rej" data-tip={s.reason}>unknown</span>}
      <span className="grow wrap"><ItemLink id={s.id} base={base} /><span className="faint mono"> {s.branch}</span>
        <span className="faint"> · {s.shared} commit{s.shared === 1 ? "" : "s"}</span></span>
    </div>
  );
}

export function GitFacts({ facts, base, pluginEdges = {} }: {
  facts?: Facts & { hints?: { conflict: string; shares: string }; blocked?: string }; base: string;
  /** The plugin instance behind each plugin-written dependency note. */
  pluginEdges?: Record<string, string>;
}) {
  if (!facts) return null;
  if (facts.blocked) {
    return (
      <section className="git-facts">
        <div className="label">Git</div>
        <div className="faint git-hint">{facts.blocked}</div>
      </section>
    );
  }
  const list = <T,>(v: T[] | undefined) => (Array.isArray(v) ? v : []);
  const branches = list(facts.branches), needs = list(facts.needs), neededBy = list(facts.needed_by), shares = list(facts.shares);
  const conflicts = list(facts.conflicts), overlaps = list(facts.overlaps);
  if (!branches.length && !needs.length && !neededBy.length && !shares.length && !conflicts.length && !overlaps.length) return null;
  return (
    <section className="git-facts">
      <div className="label">Git</div>
      {branches.map((b) => <BranchRow key={b.name} b={b} />)}
      {needs.length > 0 && <div className="label sub">needs</div>}
      {needs.map((e, i) => <EdgeRow key={`n${i}`} e={e} base={base} by={e.note ? pluginEdges[e.note] : undefined} />)}
      {neededBy.length > 0 && <div className="label sub">needed by</div>}
      {neededBy.map((e, i) => <EdgeRow key={`b${i}`} e={e} base={base} />)}
      {shares.length > 0 && <div className="label sub">shares unlanded commits with</div>}
      {shares.map((s, i) => <ShareRow key={`s${i}`} s={s} base={base} />)}
      {shares.length > 0 && facts.hints && <div className="faint git-hint">{facts.hints.shares}</div>}
      {conflicts.length > 0 && <div className="label sub">conflicts with</div>}
      {conflicts.map((h, i) => <HintRow key={`c${i}`} h={h} base={base} />)}
      {overlaps.length > 0 && <div className="label sub">overlaps with</div>}
      {overlaps.map((h, i) => <HintRow key={`o${i}`} h={h} base={base} />)}
      {(conflicts.length > 0 || overlaps.length > 0) && facts.hints && <div className="faint git-hint">{facts.hints.conflict}</div>}
      {(facts.notice || facts.error) && <div className="faint git-hint">{facts.error ?? facts.notice}</div>}
    </section>
  );
}
