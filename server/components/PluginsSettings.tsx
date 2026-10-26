"use client";
// Project settings → Plugins: the repos the project uses, and for each one
// where its setup comes from, its deploy branches, every plugin it runs or
// could turn on, and what a person can change: instances behind Configure,
// credentials for the connections a plugin uses, grants, and each plugin's run
// log. Instances, grants and credentials save through the /plugins API routes;
// the repo list through server actions.
import { useEffect, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { addPluginRepo, removePluginRepo } from "@/app/plugin-actions";
import { withBase } from "@/lib/base";
import { addInstance as addInstanceTo, describeConnections, describeTrigger, draftPlugin, fieldsOf, savedInstances, type PluginDraft } from "@/lib/plugin-form";
import { configurable, connectionNotice, enableLine, stateLine, TRACK_EXAMPLE } from "@/lib/plugin-summary";
import type { DashConnection, DashOffer, DashPlugin, DashRepo, PluginsPage } from "@/lib/plugin-views";
import { CopyButton } from "./Copy";
import { notify } from "./Toaster";
import { Stamp } from "./ui";
import { InstanceCard, RunLog, SettingInput } from "./PluginInstance";

/** Send a write to a plugins API route; the error text when it's refused. */
export async function send(project: string, path: string, method: "PUT" | "POST", body: unknown): Promise<string | null> {
  const res = await fetch(withBase(`/api/projects/${encodeURIComponent(project)}/plugins${path}`), {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }).catch(() => null);
  if (!res) return "the server couldn't be reached";
  if (res.ok) return null;
  const err = await res.json().catch(() => null);
  return err?.error ?? `the server answered ${res.status}`;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function PluginsSettings({ projectKey, page, statuses, ownersUnset, secretKeySet }: {
  projectKey: string; page: PluginsPage; statuses: readonly string[]; ownersUnset: string | null; secretKeySet: boolean;
}) {
  const main = page.repos.filter((r) => !r.folded);
  const folded = page.repos.filter((r) => r.folded);
  const section = (r: DashRepo) => !r.refusal && (
    <RepoPlugins key={r.repo} projectKey={projectKey} repo={r} statuses={statuses} secretKeySet={secretKeySet} />
  );
  return (
    <div className="plugins">
      <p className="plugins-intro">
        Plugins add links, dependency edges, log lines and buttons to items as their branches and statuses change. A repo&apos;s
        {" "}<code>.todo-plugins/plugins.yaml</code> on its default branch decides which plugins it can run; this page configures them.
      </p>
      {ownersUnset && <p className="hot owners-unset">{ownersUnset} Plugins are off until the server&apos;s operator sets <code>TODO_PLUGIN_OWNERS</code>.</p>}
      <div className="label section">Repos</div>
      <RepoList projectKey={projectKey} repos={main} folded={folded} />
      {main.map(section)}
      {folded.length > 0 && (
        <details className="folded-repos">
          <summary><span className="chev">›</span> {plural(folded.length, "other repo")} with a reported checkout</summary>
          <p className="hint">A teammate&apos;s CLI reported a checkout of each, which lets the project use it, but no item names it.</p>
          {folded.map((r) => <RepoRow key={r.repo} projectKey={projectKey} r={r} />)}
          {folded.map(section)}
        </details>
      )}
    </div>
  );
}

function useRepoAction() {
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; message?: string }>, then?: () => void) => start(async () => {
    const r = await fn();
    if (!r.ok) notify(r.message ?? "Not saved.");
    else then?.();
  });
  return { pending, run };
}

function RepoList({ projectKey, repos, folded }: { projectKey: string; repos: DashRepo[]; folded: DashRepo[] }) {
  const [draft, setDraft] = useState("");
  const { pending, run } = useRepoAction();
  return (
    <div className="plugin-repos">
      <p className="hint">The repos this project&apos;s items name, and any added here.</p>
      {repos.map((r) => <RepoRow key={r.repo} projectKey={projectKey} r={r} />)}
      {!repos.length && <p className="empty">{folded.length ? "No item names a repo yet." : "No repos yet."}</p>}
      <form className="rule-row" onSubmit={(e) => { e.preventDefault(); run(() => addPluginRepo(projectKey, draft), () => setDraft("")); }}>
        <label className="field">
          <span className="field-label">Add a repo</span>
          <input aria-label="add a repo" placeholder="owner/name" value={draft} onChange={(e) => setDraft(e.target.value)} />
        </label>
        <button type="submit" className="btn" disabled={pending || !draft.trim()}>add repo</button>
      </form>
    </div>
  );
}

function RepoRow({ projectKey, r }: { projectKey: string; r: DashRepo }) {
  const { pending, run } = useRepoAction();
  const why = [r.items ? plural(r.items, "item") : null, r.listed ? `added by ${r.listed.by}` : null].filter(Boolean).join(" · ");
  return (
    <div className="repo-row" data-repo={r.repo}>
      <div className="rrow">
        <a className="mono" href={`#repo-${r.repo}`}>{r.repo}</a>
        {r.listed && <span className="tag" data-tip={`listed by ${r.listed.by}`}>listed</span>}
        {r.checkout && <span className="tag" data-tip="a member's CLI reported a checkout of it">checkout</span>}
        <span className="grow faint">{why}</span>
        {r.addable && (
          <button type="button" className="btn" disabled={pending} onClick={() => run(() => addPluginRepo(projectKey, r.repo))}>add to project</button>
        )}
        {r.listed && (
          <button type="button" className="x" aria-label={`remove ${r.repo}`} disabled={pending}
                  data-tip={r.checkout ? "a member's checkout still allows it" : "remove from the list"}
                  onClick={() => run(() => removePluginRepo(projectKey, r.repo))}>✕</button>
        )}
      </div>
      {r.refusal && <p className="hint hot repo-refusal">{r.refusal}</p>}
    </div>
  );
}

function RepoPlugins({ projectKey, repo, statuses, secretKeySet }: { projectKey: string; repo: DashRepo; statuses: readonly string[]; secretKeySet: boolean }) {
  const unused = repo.connections.filter((c) => !c.usedBy.length && connectionNotice(false, c));
  return (
    <section className="plugin-repo" data-repo={repo.repo} id={`repo-${repo.repo}`}>
      <h2 className="repo-head mono">{repo.repo}</h2>
      <dl className="repo-facts">
        <dt>Setup</dt>
        <dd className="repo-source"><Source repo={repo} /></dd>
        <dt>Deploy branches</dt>
        <dd className="repo-track"><Track repo={repo} /></dd>
      </dl>
      <div className="label sub">Plugins</div>
      {repo.plugins.map((p) => (
        <PluginCard key={`${p.name}:${JSON.stringify(p.instances)}:${JSON.stringify(p.grant)}`} projectKey={projectKey} repo={repo} plugin={p}
                    statuses={statuses} secretKeySet={secretKeySet} />
      ))}
      {repo.offered.length > 0 && <Offered repo={repo} />}
      {unused.length > 0 && (
        <div className="plugin-connections">
          <div className="label sub">Connections the file declares that no plugin uses yet</div>
          {unused.map((c) => <ConnectionRow key={c.name} projectKey={projectKey} repo={repo.repo} c={c} shipped={false} secretKeySet={secretKeySet} />)}
        </div>
      )}
    </section>
  );
}

function Source({ repo }: { repo: DashRepo }) {
  const s = repo.source!;
  const file = <code>{s.path}</code>;
  let text: ReactNode;
  if (!s.branch) text = <>GitHub doesn&apos;t show this repo to the server, so it can&apos;t read {file}. Only pr-link runs.</>;
  else if (!s.exists) text = <>{file} isn&apos;t on <code>{s.branch}</code>, so only pr-link runs.</>;
  else text = <>{file} on <code>{s.branch}</code>{s.commit && <span className="faint">, read at commit {s.commit.slice(0, 7)}</span>}.</>;
  return (
    <>
      <span>{text}</span>
      {repo.errors.length > 0 && (
        <ul className="problems">{repo.errors.map((e) => <li key={e} className="error">{e}</li>)}</ul>
      )}
    </>
  );
}

function Track({ repo }: { repo: DashRepo }) {
  if (repo.track.length) {
    return (
      <>
        <span className="mono">{repo.track.join(", ")}</span>
        <span className="hint"> — items show whether their work has landed in each. Set by <code>track:</code> in the file.</span>
      </>
    );
  }
  const branch = repo.source?.branch ?? "the default branch";
  return (
    <>
      <span>None, so each item&apos;s dependencies are measured against its PR&apos;s base branch. </span>
      <span className="hint">To measure them against deploy branches, add </span>
      <CopyButton text={TRACK_EXAMPLE} tip="copy the line" className="code-copy"><code>{TRACK_EXAMPLE}</code></CopyButton>
      <span className="hint"> to <code>{repo.source?.path}</code> on {repo.source?.branch ? <code>{branch}</code> : branch}, listing your own branches.</span>
    </>
  );
}

function Offered({ repo }: { repo: DashRepo }) {
  return (
    <div className="plugin-offers">
      <div className="label sub">Off in this repo</div>
      <p className="hint">
        To turn one on, add its line under <code>plugins:</code> in <code>{repo.source?.path}</code>
        {repo.source?.branch ? <> on <code>{repo.source.branch}</code></> : null}:
      </p>
      {repo.offered.map((o) => <Offer key={o.name} o={o} />)}
    </div>
  );
}

function Offer({ o }: { o: DashOffer }) {
  const line = enableLine(o.name);
  return (
    <div className="plugin-offer" data-offer={o.name}>
      <span className="plugin-name">{o.name}</span>
      <span className="offer-desc">{o.description}</span>
      <CopyButton text={line} tip="copy the line" className="code-copy"><code>{line}</code></CopyButton>
    </div>
  );
}

function ConnectionRow({ projectKey, repo, c, shipped, secretKeySet }: {
  projectKey: string; repo: string; c: DashConnection; shipped: boolean; secretKeySet: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const notice = connectionNotice(shipped, c);
  if (!notice) return null;
  const post = (value: string | null) => start(async () => {
    const err = await send(projectKey, "/credentials", "POST", { repo, connection: c.name, secret: value });
    setError(err);
    if (!err) {
      setOpen(false);
      setSecret("");
      router.refresh();
    }
  });
  return (
    <div className="conn-row" data-connection={c.name}>
      <div className="rrow">
        <span className="faint">connection</span>
        <span className="mono" data-tip={c.url ? `${c.kind} · ${c.url}` : undefined}>{c.name}:</span>
        <span className={`grow wrap ${notice.hot ? "hot" : "faint"}`}>{notice.text}</span>
        {notice.form && (
          <button type="button" className="btn" onClick={() => { setOpen(!open); setError(null); }}>{c.held ? "replace" : "set"} credential</button>
        )}
        {notice.form && c.held && (
          <button type="button" className="btn danger" disabled={pending} onClick={() => post(null)}>clear</button>
        )}
      </div>
      {open && !secretKeySet && <p className="hint hot">TODO_SECRET_KEY isn&apos;t set on the server, so it can&apos;t store credentials.</p>}
      {open && (
        <form className="rule-row cred-form" onSubmit={(e) => { e.preventDefault(); if (secret) post(secret); }}>
          <label className="field">
            <span className="field-label">Secret for {c.name}</span>
            <input type="password" autoComplete="new-password" aria-label={`${c.name} secret`} placeholder="never shown again"
                   value={secret} onChange={(e) => setSecret(e.target.value)} />
          </label>
          <button type="submit" className="btn primary" disabled={pending || !secret}>save</button>
          <button type="button" className="btn" onClick={() => setOpen(false)}>cancel</button>
        </form>
      )}
      {error && <p className="hot">Not saved: {error}</p>}
    </div>
  );
}

/** Cards saved since the page last loaded, so the card the refreshed data remounts still says so. */
const justSaved = new Set<string>();
/** Configure sections a person opened, kept open across the remount a save causes. */
const opened = new Set<string>();

function PluginCard({ projectKey, repo, plugin, statuses, secretKeySet }: {
  projectKey: string; repo: DashRepo; plugin: DashPlugin; statuses: readonly string[]; secretKeySet: boolean;
}) {
  const state = stateLine(plugin);
  const on = plugin.on ?? [];
  const meta = [
    on.length ? `runs on ${on.map(describeTrigger).join(", ")}` : null, plugin.every ? `every ${plugin.every}` : null,
    plugin.per ? `per ${plugin.per}` : null, plugin.connections.length ? `calls ${describeConnections(plugin.connections)}` : null,
  ].filter(Boolean).join(" · ");
  const connections = repo.connections.filter((c) => c.usedBy.includes(plugin.name));
  return (
    <section className="plugin-card" data-plugin={plugin.name}>
      <div className="plugin-head">
        <span className="plugin-name">{plugin.name}</span>
        {plugin.shipped
          ? <span className="tag ok" data-tip={plugin.always ? "ships with todo and is on in every repo" : "ships with todo; the repo's file turns it on"}>shipped</span>
          : <span className="tag" data-tip="defined in the repo's plugins file">repo</span>}
        {plugin.code && <span className="tag">code</span>}
        {plugin.exclusive && <span className="tag" data-tip="fires at most one instance per event, the first in order">first match</span>}
        <span className={`plugin-state ${state.hot ? "hot" : ""}`}>{state.text}</span>
      </div>
      {plugin.description && <p className="plugin-desc">{plugin.description}</p>}
      {meta && <p className="plugin-meta faint">{meta}</p>}
      {connections.map((c) => (
        <ConnectionRow key={c.name} projectKey={projectKey} repo={repo.repo} c={c} shipped={plugin.shipped} secretKeySet={secretKeySet} />
      ))}
      {plugin.capabilities.includes("post-request") && <Grant projectKey={projectKey} repo={repo.repo} plugin={plugin} />}
      {configurable(plugin) && <Configure projectKey={projectKey} repo={repo} plugin={plugin} statuses={statuses} />}
      <details className="run-logs">
        <summary><span className="chev">›</span> Run log</summary>
        {plugin.instances.map((i) => <RunLog key={i.id} name={i.name || i.id} rows={plugin.runs[i.id] ?? []} projectKey={projectKey} />)}
        {!plugin.instances.length && <p className="empty">No instance, so no runs.</p>}
      </details>
    </section>
  );
}

function Configure({ projectKey, repo, plugin, statuses }: { projectKey: string; repo: DashRepo; plugin: DashPlugin; statuses: readonly string[] }) {
  const router = useRouter();
  const id = `${repo.repo}/${plugin.name}`;
  const [draft, setDraft] = useState<PluginDraft>(() => draftPlugin(plugin, plugin.instances, plugin.declared));
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState<{ ok: boolean; message: string } | null>(() => (justSaved.delete(id) ? { ok: true, message: "Saved." } : null));
  const [pending, start] = useTransition();
  // Between a save and the refreshed data the form is locked, since the new data replaces the drafts.
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    setRefreshing(false);
    justSaved.delete(id);
  }, [plugin, id]);
  const out = savedInstances(plugin, draft);
  const shared = fieldsOf(plugin.settings).filter((f) => f.scope === "plugin");
  const ordered = plugin.exclusive && draft.instances.length > 1;
  const change = (next: PluginDraft) => { setDraft(next); setDirty(true); setSaved(null); };
  const save = () => start(async () => {
    const err = await send(projectKey, "", "PUT", { repo: repo.repo, plugin: plugin.name, instances: out.instances });
    setSaved(err ? { ok: false, message: err } : { ok: true, message: "Saved." });
    if (!err) {
      setDirty(false);
      setRefreshing(true);
      justSaved.add(id);
      router.refresh();
    }
  });
  const n = plugin.instances.length;
  return (
    <details className="configure" open={opened.has(id)} onToggle={(e) => { if (e.currentTarget.open) opened.add(id); else opened.delete(id); }}>
      <summary><span className="chev">›</span> Configure <span className="faint">· {n ? plural(n, "instance") : "no instance yet"}</span></summary>
      <fieldset className="plugin-edit" disabled={pending || refreshing}>
        {shared.length > 0 && (
          <div className="plugin-shared">
            <div className="label sub">Shared by every instance</div>
            {shared.map((f) => (
              <SettingInput key={f.key} field={f} value={draft.shared[f.key]} onChange={(v) => change({ ...draft, shared: { ...draft.shared, [f.key]: v } })} />
            ))}
          </div>
        )}
        {ordered && <p className="hint">Only the first instance that matches an event runs, in this order.</p>}
        <div className="instances">
          {draft.instances.map((x, i) => {
            const live = plugin.instances.find((p) => p.id === (x.storedAs ?? x.id));
            return (
              <InstanceCard key={x.key} plugin={plugin} draft={draft} x={x} index={i} ordered={ordered} statuses={statuses} onChange={change}
                            available={repo.available} serverRuns={live && x.storedAs ? { runs: live.server_runs, reason: live.server_runs_reason } : null} />
            );
          })}
          {!draft.instances.length && <p className="empty">No instances: it doesn&apos;t run.</p>}
        </div>
        <div className="save-row">
          <button type="button" className="add" onClick={() => change(addInstanceTo(plugin, draft))}><span className="pl">+</span>instance</button>
          <button type="button" className="btn primary" disabled={pending || !dirty || out.errors.length > 0} onClick={save}>{pending ? "saving…" : "save instances"}</button>
          {saved && <span className={saved.ok ? "hint" : "hot"}>{saved.ok ? saved.message : `Not saved: ${saved.message}`}</span>}
        </div>
        {(out.errors.length > 0 || out.warnings.length > 0) && (
          <ul className="problems">
            {out.errors.map((e) => <li key={e} className="error">{e}</li>)}
            {out.warnings.map((e) => <li key={e} className="warning">{e}</li>)}
          </ul>
        )}
      </fieldset>
    </details>
  );
}

function Grant({ projectKey, repo, plugin }: { projectKey: string; repo: string; plugin: DashPlugin }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const granted = !!plugin.grant?.capabilities.includes("post-request");
  const toggle = (on: boolean) => start(async () => {
    const rest = (plugin.grant?.capabilities ?? []).filter((c) => c !== "post-request");
    const err = await send(projectKey, "", "PUT", { repo, plugin: plugin.name, grants: on ? [...rest, "post-request"] : rest });
    setError(err);
    if (!err) router.refresh();
  });
  return (
    <label className="switch grant">
      <input type="checkbox" checked={granted} disabled={pending} onChange={(e) => toggle(e.target.checked)} />
      may post a new request version <code>post-request</code>
      <span className="hint">{plugin.grant && granted ? <>granted by {plugin.grant.by}, <Stamp ts={plugin.grant.at} /></> : "not granted: its requests are dropped"}</span>
      {error && <span className="hot">Not saved: {error}</span>}
    </label>
  );
}
