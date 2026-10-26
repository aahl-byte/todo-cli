"use client";
// Project settings → Plugins: the repos the project may use, and for each one
// its plugins, their instances (switches, triggers, settings forms, order),
// the connections they need with this server's credentials, grants, and each
// instance's run log. Instances, grants and credentials save through the
// /plugins API routes; the repo list through server actions.
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addPluginRepo, removePluginRepo } from "@/app/plugin-actions";
import { withBase } from "@/lib/base";
import { addInstance as addInstanceTo, describeConnections, describeTrigger, draftPlugin, fieldsOf, savedInstances, type PluginDraft } from "@/lib/plugin-form";
import type { DashConnection, DashPlugin, DashRepo, PluginsPage } from "@/lib/plugin-views";
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

export function PluginsSettings({ projectKey, page, statuses, ownersUnset, secretKeySet }: {
  projectKey: string; page: PluginsPage; statuses: readonly string[]; ownersUnset: string | null; secretKeySet: boolean;
}) {
  return (
    <div className="plugins">
      <div className="label section">Repos</div>
      {ownersUnset && <p className="hot owners-unset">{ownersUnset} Plugins are off until the server&apos;s operator sets <code>TODO_PLUGIN_OWNERS</code>.</p>}
      <RepoList projectKey={projectKey} repos={page.repos} />
      {page.repos.filter((r) => !r.refusal).map((r) => (
        <RepoPlugins key={r.repo} projectKey={projectKey} repo={r} statuses={statuses} secretKeySet={secretKeySet} />
      ))}
    </div>
  );
}

function RepoList({ projectKey, repos }: { projectKey: string; repos: DashRepo[] }) {
  const [draft, setDraft] = useState("");
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; message?: string }>, then?: () => void) => start(async () => {
    const r = await fn();
    if (!r.ok) notify(r.message ?? "Not saved.");
    else then?.();
  });
  return (
    <div className="plugin-repos">
      <p className="hint">The repos this project reads from GitHub and runs plugins for: those listed here, and any a member&apos;s CLI has reported a checkout of.</p>
      {repos.map((r) => (
        <div key={r.repo} className="rrow repo-row" data-repo={r.repo}>
          <span className="mono">{r.repo}</span>
          {r.listed && <span className="tag" data-tip={`listed by ${r.listed.by}`}>listed</span>}
          {r.checkout && <span className="tag" data-tip="a member's CLI reported a checkout of it">checkout</span>}
          <span className="grow faint">{r.refusal ?? (r.listed ? `added by ${r.listed.by}` : "")}</span>
          {r.listed && (
            <button type="button" className="x" aria-label={`remove ${r.repo}`} disabled={pending}
                    data-tip={r.checkout ? "a member's checkout still allows it" : "remove from the list"}
                    onClick={() => run(() => removePluginRepo(projectKey, r.repo))}>✕</button>
          )}
        </div>
      ))}
      {!repos.length && <p className="empty">No repos yet.</p>}
      <form className="rule-row" onSubmit={(e) => { e.preventDefault(); run(() => addPluginRepo(projectKey, draft), () => setDraft("")); }}>
        <input aria-label="add a repo" placeholder="owner/name" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button type="submit" className="btn" disabled={pending || !draft.trim()}>add repo</button>
      </form>
    </div>
  );
}

function RepoPlugins({ projectKey, repo, statuses, secretKeySet }: { projectKey: string; repo: DashRepo; statuses: readonly string[]; secretKeySet: boolean }) {
  return (
    <section className="plugin-repo" data-repo={repo.repo}>
      <div className="label section">{repo.repo}</div>
      {repo.errors.length > 0 && (
        <ul className="problems">{repo.errors.map((e) => <li key={e} className="error">{e}</li>)}</ul>
      )}
      <Connections projectKey={projectKey} repo={repo.repo} rows={repo.connections} secretKeySet={secretKeySet} />
      {repo.plugins.map((p) => (
        <PluginCard key={`${p.name}:${JSON.stringify(p.instances)}:${JSON.stringify(p.grant)}`} projectKey={projectKey} repo={repo.repo} plugin={p}
                    statuses={statuses} available={repo.available} />
      ))}
    </section>
  );
}

function Connections({ projectKey, repo, rows, secretKeySet }: { projectKey: string; repo: string; rows: DashConnection[]; secretKeySet: boolean }) {
  if (!rows.length) return null;
  return (
    <div className="plugin-connections">
      <div className="label sub">Connections</div>
      {!secretKeySet && rows.some((c) => c.origin === "repo") && (
        <p className="hint">TODO_SECRET_KEY isn&apos;t set on the server, so it can&apos;t store credentials.</p>
      )}
      {rows.map((c) => <ConnectionRow key={c.name} projectKey={projectKey} repo={repo} c={c} />)}
    </div>
  );
}

function connectionState(c: DashConnection): { text: string; hot: boolean } {
  if (c.origin === "missing") return { text: "declared nowhere: neither the repo file nor this server has it", hot: true };
  if (c.command) return { text: "starts a local command, which only a developer's CLI runs", hot: false };
  if (c.origin === "host") {
    if (!c.needsSecret) return { text: "this server's; needs no secret", hot: false };
    return c.held ? { text: "this server's, with its secret; only plugins shipped with todo get it", hot: false }
      : { text: "this server's, without a secret", hot: true };
  }
  if (!c.needsSecret) return { text: c.held ? "credential stored" : "needs no secret", hot: false };
  return c.held ? { text: "credential stored", hot: false } : { text: "no credential on this server", hot: true };
}

function ConnectionRow({ projectKey, repo, c }: { projectKey: string; repo: string; c: DashConnection }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const state = connectionState(c);
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
        <span className="mono">{c.name}</span>
        <span className="tag">{c.origin === "repo" ? "repo" : c.origin === "host" ? "server" : "missing"}</span>
        {c.kind && <span className="faint">{c.kind}{c.url ? ` · ${c.url}` : ""}</span>}
        <span className={`grow ${state.hot ? "hot" : "faint"}`}>{state.text}</span>
        <span className="faint">used by {c.usedBy.join(", ") || "nothing"}</span>
        {c.origin === "repo" && !c.command && (
          <button type="button" className="btn" onClick={() => { setOpen(!open); setError(null); }}>{c.held ? "replace" : "set"} credential</button>
        )}
        {c.origin === "repo" && c.held && (
          <button type="button" className="btn danger" disabled={pending} onClick={() => post(null)}>clear</button>
        )}
      </div>
      {open && (
        <form className="rule-row cred-form" onSubmit={(e) => { e.preventDefault(); if (secret) post(secret); }}>
          <input type="password" autoComplete="new-password" aria-label={`${c.name} secret`} placeholder="secret, never shown again"
                 value={secret} onChange={(e) => setSecret(e.target.value)} />
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

function PluginCard({ projectKey, repo, plugin, statuses, available }: {
  projectKey: string; repo: string; plugin: DashPlugin; statuses: readonly string[]; available: DashRepo["available"];
}) {
  const router = useRouter();
  const id = `${repo}/${plugin.name}`;
  const [draft, setDraft] = useState<PluginDraft>(() => draftPlugin(plugin, plugin.instances, plugin.declared));
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState<{ ok: boolean; message: string } | null>(() => (justSaved.delete(id) ? { ok: true, message: "Saved." } : null));
  const [pending, start] = useTransition();
  // Between a save and the refreshed data the card is locked, since the new data replaces the drafts.
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    setRefreshing(false);
    justSaved.delete(id);
  }, [plugin, id]);
  const out = savedInstances(plugin, draft);
  const shared = fieldsOf(plugin.settings).filter((f) => f.scope === "plugin");
  const change = (next: PluginDraft) => { setDraft(next); setDirty(true); setSaved(null); };
  const save = () => start(async () => {
    const err = await send(projectKey, "", "PUT", { repo, plugin: plugin.name, instances: out.instances });
    setSaved(err ? { ok: false, message: err } : { ok: true, message: "Saved." });
    if (!err) {
      setDirty(false);
      setRefreshing(true);
      justSaved.add(id);
      router.refresh();
    }
  });
  const on = plugin.on ?? [];
  return (
    <section className="plugin-card" data-plugin={plugin.name}>
      <div className="plugin-head">
        <span className="plugin-name">{plugin.name}</span>
        {plugin.shipped && <span className="tag ok">shipped</span>}
        {plugin.code && <span className="tag">code</span>}
        {plugin.exclusive && <span className="tag" data-tip="fires at most one instance per event, the first in order">exclusive</span>}
        <span className="faint">on {on.length ? on.map(describeTrigger).join(", ") : "nothing"}</span>
        {plugin.every && <span className="faint">· every {plugin.every}</span>}
        {plugin.per && <span className="faint">· per {plugin.per}</span>}
        {plugin.connections.length > 0 && <span className="faint">· via {describeConnections(plugin.connections)}</span>}
      </div>
      {plugin.capabilities.includes("post-request") && (
        <Grant projectKey={projectKey} repo={repo} plugin={plugin} />
      )}
      <fieldset className="plugin-edit" disabled={pending || refreshing}>
      {shared.length > 0 && (
        <div className="plugin-shared">
          <div className="label sub">Shared by every instance</div>
          {shared.map((f) => (
            <SettingInput key={f.key} field={f} value={draft.shared[f.key]} onChange={(v) => change({ ...draft, shared: { ...draft.shared, [f.key]: v } })} />
          ))}
        </div>
      )}
      <div className="instances">
        {draft.instances.map((x, i) => {
          const live = plugin.instances.find((p) => p.id === (x.storedAs ?? x.id));
          return (
            <InstanceCard key={x.key} plugin={plugin} draft={draft} x={x} index={i} statuses={statuses} onChange={change} available={available}
                          serverRuns={live && x.storedAs ? { runs: live.server_runs, reason: live.server_runs_reason } : null} />
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
      <details className="run-logs">
        <summary><span className="chev">›</span> Run log</summary>
        {plugin.instances.map((i) => <RunLog key={i.id} name={i.name || i.id} rows={plugin.runs[i.id] ?? []} projectKey={projectKey} />)}
      </details>
    </section>
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
