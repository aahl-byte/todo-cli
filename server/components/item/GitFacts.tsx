// The item's git facts: where each branch landed and any hint about its PR's
// base, what it needs and what needs it, the branches it shares unlanded
// commits with, then the other branches that change the same files. Derived from git; nothing
// here edits.
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

/** One other item's branch and the files both branches change, the conflicting ones split out. */
export interface FileClash { id: string; title?: string; status?: string; branch: string; via: string; conflict: string[]; overlap: string[] }

/** Conflicts and overlaps folded into one entry per other branch, the most conflicting first. */
export function fileClashes(conflicts: Hint[], overlaps: Hint[]): FileClash[] {
  const byKey = new Map<string, FileClash>();
  const entry = (h: Hint) => {
    const key = `${h.id}\0${h.branch}\0${h.via}`;
    let e = byKey.get(key);
    if (!e) byKey.set(key, (e = { id: h.id, branch: h.branch, via: h.via, conflict: [], overlap: [] }));
    if (h.title) e.title = h.title;
    if (h.status) e.status = h.status;
    return e;
  };
  for (const h of conflicts) entry(h).conflict.push(...h.files);
  for (const h of overlaps) {
    const e = entry(h);
    e.overlap.push(...h.files.filter((f) => !e.conflict.includes(f) && !e.overlap.includes(f)));
  }
  return [...byKey.values()].sort((a, b) => b.conflict.length - a.conflict.length
    || b.overlap.length - a.overlap.length || a.id.localeCompare(b.id));
}

/** Files grouped by folder, a group's conflicting files first. */
export function byFolder(conflict: string[], overlap: string[]): { dir: string; files: { name: string; conflict: boolean }[] }[] {
  const groups = new Map<string, { name: string; conflict: boolean }[]>();
  const add = (path: string, isConflict: boolean) => {
    const cut = path.lastIndexOf("/");
    const dir = cut < 0 ? "" : path.slice(0, cut + 1);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir)!.push({ name: path.slice(cut + 1), conflict: isConflict });
  };
  for (const f of conflict) add(f, true);
  for (const f of overlap) add(f, false);
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([dir, files]) => ({
    dir, files: files.sort((a, b) => Number(b.conflict) - Number(a.conflict) || a.name.localeCompare(b.name)),
  }));
}

const SHOWN_PER_FOLDER = 3;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function FileName({ name, conflict }: { name: string; conflict: boolean }) {
  return <div className={conflict ? "git-file conflict" : "git-file"} data-tip={conflict ? "won't merge cleanly" : "changed on both, merges cleanly"}>{name}</div>;
}

function Folder({ dir, files }: { dir: string; files: { name: string; conflict: boolean }[] }) {
  const conflicting = files.filter((f) => f.conflict), clean = files.filter((f) => !f.conflict);
  const shown = [...conflicting, ...clean.slice(0, SHOWN_PER_FOLDER)];
  const rest = clean.slice(SHOWN_PER_FOLDER);
  return (
    <div className="git-folder">
      {dir && <div className="git-dir">{dir}</div>}
      {shown.map((f) => <FileName key={f.name} {...f} />)}
      {rest.length > 0 && (
        <details className="git-more">
          <summary>+{plural(rest.length, "more file")}</summary>
          {rest.map((f) => <FileName key={f.name} {...f} />)}
        </details>
      )}
    </div>
  );
}

function ClashRow({ c, base, showVia }: { c: FileClash; base: string; showVia: boolean }) {
  const total = c.conflict.length + c.overlap.length;
  return (
    <details className="git-clash">
      <summary>
        <span className="git-clash-title">
          {c.status && <span className={`git-dot s-${c.status}`} data-tip={c.status} aria-label={`status: ${c.status}`} />}
          <a className="git-clash-item" href={withBase(`${base}/i/${c.id}`)} data-tip={c.id}>{c.title ?? c.id}</a>
        </span>
        <span className="git-clash-sub faint">
          {c.conflict.length > 0
            ? <span className="git-conflicts" data-tip="files that won't merge cleanly">{plural(c.conflict.length, "conflict")}</span>
            : <span data-tip="files both branches change; they merge cleanly">merges cleanly</span>}
          <span>&nbsp;· {plural(total, "file")}{showVia ? ` with ${c.via}` : ""} ·&nbsp;</span>
          <span className="mono git-clash-branch" data-tip={c.branch}>{c.branch}</span>
        </span>
      </summary>
      <div className="git-files">
        {byFolder(c.conflict, c.overlap).map((g) => <Folder key={g.dir} {...g} />)}
      </div>
    </details>
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
  const clashes = fileClashes(list(facts.conflicts), list(facts.overlaps));
  if (!branches.length && !needs.length && !neededBy.length && !shares.length && !clashes.length) return null;
  return (
    <section className="git-facts">
      <div className="label">Git</div>
      {branches.map((b) => <BranchRow key={b.name} b={b} />)}
      {branches.filter((b) => b.hint).map((b) => <div key={`h${b.name}`} className="faint git-hint">{b.hint}</div>)}
      {needs.length > 0 && <div className="label sub">needs</div>}
      {needs.map((e, i) => <EdgeRow key={`n${i}`} e={e} base={base} by={e.note ? pluginEdges[e.note] : undefined} />)}
      {neededBy.length > 0 && <div className="label sub">needed by</div>}
      {neededBy.map((e, i) => <EdgeRow key={`b${i}`} e={e} base={base} />)}
      {shares.length > 0 && <div className="label sub">shares unlanded commits with</div>}
      {shares.map((s, i) => <ShareRow key={`s${i}`} s={s} base={base} />)}
      {shares.length > 0 && facts.hints && <div className="faint git-hint">{facts.hints.shares}</div>}
      {clashes.length > 0 && <div className="label sub">changes the same files as</div>}
      {clashes.map((c) => <ClashRow key={`${c.id} ${c.branch} ${c.via}`} c={c} base={base} showVia={branches.length > 1} />)}
      {clashes.length > 0 && facts.hints && <div className="faint git-hint">{facts.hints.conflict}</div>}
      {(facts.notice || facts.error) && <div className="faint git-hint">{facts.error ?? facts.notice}</div>}
    </section>
  );
}
