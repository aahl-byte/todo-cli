"use client";
// Project settings → Automation: pick a repo, then one row per thing todo can
// do for its items, each saying whether it's on, what it last did, or the steps
// that turn it on and who takes them. A row's settings (instances, credentials,
// grants) and its run history open beneath it. Settings save through the
// /plugins API routes; the repo list through server actions.
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { addPluginRepo, removePluginRepo } from "@/app/plugin-actions";
import { automationRows, repoChoices, WHO, type AutomationRow, type LastRun, type RowState, type Step } from "@/lib/automation";
import { withBase } from "@/lib/base";
import { addInstance as addInstanceTo, describeConnections, describeTrigger, draftPlugin, fieldsOf, savedInstances, type PluginDraft } from "@/lib/plugin-form";
import { configurable, connectionNotice } from "@/lib/plugin-summary";
import type { AutomationPage, DashConnection, DashPlugin, DashRepo, RepoEntry } from "@/lib/plugin-views";
import { CopyButton } from "./Copy";
import { InstanceCard, RunLog, SettingInput } from "./PluginInstance";
import { notify } from "./Toaster";
import { Ago, Stamp } from "./ui";

/** Send a write to a plugins API route; the error text when it's refused. */
async function send(project: string, path: string, method: "PUT" | "POST", body: unknown): Promise<string | null> {
  const res = await fetch(withBase(`/api/projects/${encodeURIComponent(project)}/plugins${path}`), {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }).catch(() => null);
  if (!res) return "the server couldn't be reached";
  if (res.ok) return null;
  const err = await res.json().catch(() => null);
  return err?.error ?? `the server answered ${res.status}`;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

const STATE_LABEL: Record<RowState, string> = { on: "On", setup: "Needs setup", elsewhere: "Elsewhere", off: "Off" };

export function AutomationSettings({ projectKey, page, statuses, secretKeySet }: {
  projectKey: string; page: AutomationPage; statuses: readonly string[]; secretKeySet: boolean;
}) {
  const repo = page.selected;
  const rows = repo ? automationRows(repo, { project: projectKey, bridge: page.bridge, host: page.host }) : [];
  return (
    <div className="automation">
      <h1>Automation</h1>
      <p className="automation-intro">
        todo can keep items up to date from GitHub, Vercel and Jira on its own. Pick a repo to see what it does for that repo&apos;s
        items, and how to turn more on.
      </p>
      {!page.ownersSet && (
        <p className="hot automation-off">Automation is off on this server. Its admin sets <code>TODO_PLUGIN_OWNERS</code> to the GitHub owners whose repos it reads.</p>
      )}
      {page.ownersSet && !page.pluginsOn && (
        <p className="hot automation-off">Automation is off on this server. Its admin sets <code>GITHUB_TOKEN</code> so it can read GitHub.</p>
      )}
      <RepoPicker projectKey={projectKey} repos={page.repos} selected={repo} />
      {repo && (
        <div className="auto-rows" data-repo={repo.repo}>
          {rows.map((r) => (
            <Row key={`${repo.repo}/${r.key}`} projectKey={projectKey} repo={repo} row={r} statuses={statuses} secretKeySet={secretKeySet} />
          ))}
          <UnusedConnections projectKey={projectKey} repo={repo} secretKeySet={secretKeySet} />
        </div>
      )}
    </div>
  );
}

// ── the repo picker ───────────────────────────────────────────────────────────
function useRepoAction() {
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; message?: string }>, then?: () => void) => start(async () => {
    const r = await fn();
    if (!r.ok) notify(r.message ?? "Not saved. Try again.");
    else then?.();
  });
  return { pending, run };
}

const option = (r: RepoEntry) => `${r.repo} · ${plural(r.items, "item")}`;

function RepoPicker({ projectKey, repos, selected }: { projectKey: string; repos: RepoEntry[]; selected: DashRepo | null }) {
  const router = useRouter();
  const path = usePathname();
  const { main, checkoutOnly, unconnected } = repoChoices(repos);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const { pending, run } = useRepoAction();
  const go = (repo: string) => router.push(`${path}?repo=${encodeURIComponent(repo)}`);
  return (
    <div className="repo-pick">
      <div className="rule-row">
        {selected ? (
          <label className="field">
            <span className="field-label">Repo</span>
            <select aria-label="repo" value={selected.repo} onChange={(e) => go(e.target.value)}>
              {main.map((r) => <option key={r.repo} value={r.repo}>{option(r)}</option>)}
              {checkoutOnly.length > 0 && (
                <optgroup label="Known only from a teammate's checkout">
                  {checkoutOnly.map((r) => <option key={r.repo} value={r.repo}>{r.repo}</option>)}
                </optgroup>
              )}
            </select>
          </label>
        ) : <span className="empty">{unconnected.length ? "No repo is connected yet." : "No repo yet: items name theirs once a developer's todo CLI runs in a checkout."}</span>}
        {selected?.listed && (
          <button type="button" className="link-btn quiet" disabled={pending}
                  data-tip={selected.checkout ? "A teammate's checkout still connects it." : "Its items stay; todo stops reading the repo."}
                  onClick={() => run(() => removePluginRepo(projectKey, selected.repo))}>Remove from project</button>
        )}
        <button type="button" className="add" aria-expanded={adding} onClick={() => setAdding(!adding)}><span className="pl">+</span>Add a repo</button>
      </div>
      {adding && (
        <form className="rule-row add-repo" onSubmit={(e) => {
          e.preventDefault();
          const name = draft.trim();
          run(() => addPluginRepo(projectKey, name), () => { setDraft(""); setAdding(false); go(name.toLowerCase()); });
        }}>
          <input aria-label="add a repo" placeholder="owner/name" value={draft} autoFocus onChange={(e) => setDraft(e.target.value)} />
          <button type="submit" className="btn primary" disabled={pending || !draft.trim()}>Add repo</button>
          <span className="hint">todo reads the repo from GitHub and runs what it turns on.</span>
        </form>
      )}
      {unconnected.length > 0 && <Unconnected projectKey={projectKey} repos={unconnected} />}
      {selected && <Source repo={selected} />}
    </div>
  );
}

function Unconnected({ projectKey, repos }: { projectKey: string; repos: RepoEntry[] }) {
  const [open, setOpen] = useState(false);
  const { pending, run } = useRepoAction();
  const named = repos.every((r) => r.items > 0);
  return (
    <div className="unconnected">
      <div className="rrow">
        <span className="grow wrap hint">
          {plural(repos.length, "repo")} {named ? "your items name " : ""}{repos.length === 1 ? "isn't" : "aren't"} connected yet:{" "}
          <span className="mono">{repos.map((r) => r.repo).join(", ")}</span>
        </span>
        <button type="button" className="link-btn" aria-expanded={open} onClick={() => setOpen(!open)}>Connect ›</button>
      </div>
      {open && (
        <div className="unconnected-list">
          {repos.map((r) => (
            <div className="rrow" key={r.repo} data-repo={r.repo}>
              <span className="mono">{r.repo}</span>
              <span className="faint">{plural(r.items, "item")}</span>
              <span className="grow wrap hint">{r.addable ? "todo can read it once it's added to this project." : r.refusal}</span>
              {r.addable && (
                <button type="button" className="btn primary" disabled={pending} onClick={() => run(() => addPluginRepo(projectKey, r.repo))}>Connect</button>
              )}
              {r.listed && (
                <button type="button" className="btn" disabled={pending} onClick={() => run(() => removePluginRepo(projectKey, r.repo))}>Remove from project</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Source({ repo }: { repo: DashRepo }) {
  const s = repo.source;
  if (!s) return null;
  const file = <code>{s.path}</code>;
  let text;
  if (!s.branch) text = <>GitHub doesn&apos;t show this repo to the server, so todo can&apos;t read its {file}.</>;
  else if (!s.exists) text = <>This repo has no {file} on <code>{s.branch}</code> yet; the steps below say what to put in it.</>;
  else text = <>Settings for this repo come from {file} on <code>{s.branch}</code>{s.commit && <>, read at commit {s.commit.slice(0, 7)}</>}.</>;
  return (
    <div className="repo-source">
      <p className="hint">{text}</p>
      {repo.errors.length > 0 && (
        <>
          <p className="hot">The repo&apos;s plugins file has problems, so some rows may be missing. A developer fixes them on {s.branch ?? "the default branch"}:</p>
          <ul className="problems">{repo.errors.map((e) => <li key={e} className="error">{e}</li>)}</ul>
        </>
      )}
    </div>
  );
}

// ── one row ───────────────────────────────────────────────────────────────────
/** Panels a person opened, kept open across the refresh a save causes. */
const opened = new Map<string, "setup" | "history">();

function hasSettings(p: DashPlugin, repo: DashRepo): boolean {
  return configurable(p) || p.capabilities.includes("post-request")
    || repo.connections.some((c) => c.usedBy.includes(p.name) && !!connectionNotice(p.shipped, c)?.form);
}

function Row({ projectKey, repo, row, statuses, secretKeySet }: {
  projectKey: string; repo: DashRepo; row: AutomationRow; statuses: readonly string[]; secretKeySet: boolean;
}) {
  const id = `${repo.repo}/${row.key}`;
  const [panel, setPanelState] = useState<"setup" | "history" | null>(() => opened.get(id) ?? null);
  const setPanel = (p: "setup" | "history" | null) => {
    if (p) opened.set(id, p);
    else opened.delete(id);
    setPanelState(p);
  };
  const toggle = (p: "setup" | "history") => setPanel(panel === p ? null : p);
  const p = row.plugin;
  const settings = !!p && hasSettings(p, repo);
  const history = !!p && p.instances.length > 0;
  const showSteps = row.state === "setup" || row.state === "off";
  // A step that opens the settings stands in for the row's own link.
  const stepOpens = showSteps && settings && row.steps.some((s) => s.setup && !s.done);
  return (
    <section className={`auto-row ${row.state}`} data-row={row.key} data-state={row.state}>
      <div className="auto-state"><span className="dot" aria-hidden />{STATE_LABEL[row.state]}</div>
      <div className="auto-body">
        <div className="auto-head">
          <span className="auto-title">{row.title}</span>
          <span className="auto-plugins">{row.plugins.join(", ")}</span>
        </div>
        {row.last !== undefined && (row.last ? <Last projectKey={projectKey} last={row.last} /> : row.state === "on" && <p className="auto-line faint">Hasn&apos;t run yet.</p>)}
        {row.offers && row.state === "off" && <p className="auto-line">{row.offers}</p>}
        {row.notes.map((n) => (
          <p key={n.text} className={`auto-line${n.warn ? " hot" : ""}`}>
            {n.text}{n.link && <> <Link href={n.link.href}>{n.link.label} ›</Link></>}
          </p>
        ))}
        {showSteps && row.steps.length > 0 && (
          <Steps steps={row.steps} lead={row.state === "setup" ? "To finish:" : "To turn on:"} onSetup={settings ? () => setPanel("setup") : null} />
        )}
        {((settings && !stepOpens) || history) && (
          <div className="auto-actions">
            {settings && !stepOpens && (
              <button type="button" className="link-btn" aria-expanded={panel === "setup"} onClick={() => toggle("setup")}>
                {row.state === "on" ? "Settings" : "Set up"} ›
              </button>
            )}
            {history && <button type="button" className="link-btn" aria-expanded={panel === "history"} onClick={() => toggle("history")}>History ›</button>}
          </div>
        )}
        {p && panel === "setup" && <SetupPanel projectKey={projectKey} repo={repo} plugin={p} statuses={statuses} secretKeySet={secretKeySet} />}
        {p && panel === "history" && (
          <div className="auto-panel run-logs">
            {p.instances.map((i) => <RunLog key={i.id} name={i.name || i.id} rows={p.runs[i.id] ?? []} projectKey={projectKey} />)}
          </div>
        )}
      </div>
    </section>
  );
}

function Last({ projectKey, last }: { projectKey: string; last: LastRun }) {
  return (
    <p className={`auto-line last${last.tone === "fail" ? " hot" : ""}`}>
      <span className="faint">Last:</span> {last.did}{" "}
      {last.item ? <>on <a href={withBase(`/p/${projectKey}/i/${last.item.id}`)}>{last.item.id}</a></> : <span className="faint">on a removed item</span>}
      {last.detail && <span className="faint">: {last.detail}</span>}
      <span className="faint"> · </span><Ago ts={last.at} />
    </p>
  );
}

function Steps({ steps, lead, onSetup }: { steps: Step[]; lead: string; onSetup: (() => void) | null }) {
  return (
    <div className="auto-steps">
      <span className="faint">{lead}</span>
      <ol>
        {steps.map((s, i) => (
          <li key={i} className={s.done ? "done" : ""} data-who={s.who}>
            <span className="step-mark" aria-label={s.done ? "done" : undefined}>{s.done ? "✓" : `${i + 1}.`}</span>
            <span className="who">{WHO[s.who]}</span>
            <div className="step-body">
              {s.text}
              {s.setup && !s.done && onSetup && <> <button type="button" className="link-btn" onClick={onSetup}>Set up ›</button></>}
              {s.code && s.who === "repo" && (
                <div className="step-code">
                  <pre>{s.code}</pre>
                  <CopyButton text={s.code} tip="copy the YAML" className="btn">Copy</CopyButton>
                </div>
              )}
              {s.code && s.who !== "repo" && <div className="step-env">{s.code.split("\n").map((v) => <code key={v} className="env">{v}</code>)}</div>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ── a row's settings ──────────────────────────────────────────────────────────
const RUNS_ON: Record<string, string> = {
  push: "on a push", pr: "on a pull request", deployment: "on a deployment", manual: "when someone presses its button",
};

function runsOn(t: NonNullable<DashPlugin["on"]>[number]): string {
  if (typeof t === "string") return RUNS_ON[t] ?? `on ${t}`;
  const move = describeTrigger(t);
  return move === "any status move" ? "when an item moves" : `when an item moves ${move}`;
}

/** When the plugin runs, in words: "Runs on a push or on a pull request · every 1h · once per branch". */
function cadence(p: DashPlugin): string {
  const on = (p.on ?? []).map(runsOn);
  return [
    on.length ? `Runs ${on.join(" or ")}` : null, p.every ? `every ${p.every}` : null,
    p.per ? `once per ${p.per === "jira" ? "linked Jira ticket" : p.per}` : null,
    p.connections.length ? `calls ${describeConnections(p.connections)}` : null,
  ].filter(Boolean).join(" · ");
}

function SetupPanel({ projectKey, repo, plugin, statuses, secretKeySet }: {
  projectKey: string; repo: DashRepo; plugin: DashPlugin; statuses: readonly string[]; secretKeySet: boolean;
}) {
  // Connections a person can't act on here are the row's steps already.
  const connections = repo.connections.filter((c) => c.usedBy.includes(plugin.name) && connectionNotice(plugin.shipped, c)?.form);
  const line = cadence(plugin);
  return (
    <div className="auto-panel plugin-card" data-plugin={plugin.name}>
      {line && <p className="plugin-meta faint">{line}.</p>}
      {connections.map((c) => (
        <ConnectionRow key={c.name} projectKey={projectKey} repo={repo.repo} c={c} shipped={plugin.shipped} secretKeySet={secretKeySet} />
      ))}
      {plugin.capabilities.includes("post-request") && <Grant projectKey={projectKey} repo={repo.repo} plugin={plugin} />}
      {configurable(plugin) && (
        <Configure key={`${JSON.stringify(plugin.instances)}:${JSON.stringify(plugin.grant)}`} projectKey={projectKey} repo={repo} plugin={plugin} statuses={statuses} />
      )}
    </div>
  );
}

function UnusedConnections({ projectKey, repo, secretKeySet }: { projectKey: string; repo: DashRepo; secretKeySet: boolean }) {
  const unused = repo.connections.filter((c) => !c.usedBy.length && connectionNotice(false, c));
  if (!unused.length) return null;
  return (
    <details className="unused-connections">
      <summary><span className="chev">›</span> {plural(unused.length, "connection")} the plugins file declares that nothing uses yet</summary>
      {unused.map((c) => <ConnectionRow key={c.name} projectKey={projectKey} repo={repo.repo} c={c} shipped={false} secretKeySet={secretKeySet} />)}
    </details>
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
        <span className="faint">Connection</span>
        <span className="mono" data-tip={c.url ? `${c.kind} · ${c.url}` : undefined}>{c.name}:</span>
        <span className={`grow wrap ${notice.hot ? "hot" : "faint"}`}>{notice.text}</span>
        {notice.form && (
          <button type="button" className="btn" onClick={() => { setOpen(!open); setError(null); }}>{c.held ? "Replace" : "Set"} credential</button>
        )}
        {notice.form && c.held && (
          <button type="button" className="btn danger" disabled={pending} onClick={() => post(null)}>Clear</button>
        )}
      </div>
      {open && !secretKeySet && <p className="hint hot">The server can&apos;t store credentials until its admin sets TODO_SECRET_KEY.</p>}
      {open && (
        <form className="rule-row cred-form" onSubmit={(e) => { e.preventDefault(); if (secret) post(secret); }}>
          <label className="field">
            <span className="field-label">Secret for {c.name}</span>
            <input type="password" autoComplete="new-password" aria-label={`${c.name} secret`} placeholder="never shown again"
                   value={secret} onChange={(e) => setSecret(e.target.value)} />
          </label>
          <button type="submit" className="btn primary" disabled={pending || !secret}>Save</button>
          <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
        </form>
      )}
      {error && <p className="hot">Not saved: {error}. Try again.</p>}
    </div>
  );
}

/** When each plugin's settings were last saved, so the form the refreshed data remounts still says so, even after a
 * refresh that started before the save lands first. */
const justSaved = new Map<string, number>();
const SAVED_SHOWN_MS = 15_000;

function Configure({ projectKey, repo, plugin, statuses }: { projectKey: string; repo: DashRepo; plugin: DashPlugin; statuses: readonly string[] }) {
  const router = useRouter();
  const id = `${repo.repo}/${plugin.name}`;
  // A plugin with no instance starts with one to fill in, since that's what setting it up means.
  const [draft, setDraft] = useState<PluginDraft>(() => {
    const d = draftPlugin(plugin, plugin.instances, plugin.declared);
    return d.instances.length ? d : addInstanceTo(plugin, d);
  });
  const [dirty, setDirty] = useState(() => !plugin.instances.length);
  const [saved, setSaved] = useState<{ ok: boolean; message: string } | null>(
    () => (Date.now() - (justSaved.get(id) ?? 0) < SAVED_SHOWN_MS ? { ok: true, message: "Saved." } : null));
  const [pending, start] = useTransition();
  // Between a save and the refreshed data the form is locked, since the new data replaces the drafts.
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => setRefreshing(false), [plugin]);
  const out = savedInstances(plugin, draft);
  const shared = fieldsOf(plugin.settings).filter((f) => f.scope === "plugin");
  const ordered = plugin.exclusive && draft.instances.length > 1;
  const change = (next: PluginDraft) => { setDraft(next); setDirty(true); setSaved(null); justSaved.delete(id); };
  const save = () => start(async () => {
    const err = await send(projectKey, "", "PUT", { repo: repo.repo, plugin: plugin.name, instances: out.instances });
    setSaved(err ? { ok: false, message: err } : { ok: true, message: "Saved." });
    if (!err) {
      setDirty(false);
      setRefreshing(true);
      justSaved.set(id, Date.now());
      router.refresh();
    }
  });
  return (
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
        {!draft.instances.length && <p className="empty">No instance yet, so it doesn&apos;t run. Add one.</p>}
      </div>
      <div className="save-row">
        <button type="button" className="add" onClick={() => change(addInstanceTo(plugin, draft))}><span className="pl">+</span>Add instance</button>
        <button type="button" className="btn primary" disabled={pending || !dirty || out.errors.length > 0} onClick={save}>{pending ? "Saving…" : "Save"}</button>
        {saved && <span className={saved.ok ? "hint" : "hot"}>{saved.ok ? saved.message : `Not saved: ${saved.message}. Fix it and save again.`}</span>}
      </div>
      {(out.errors.length > 0 || out.warnings.length > 0) && (
        <ul className="problems">
          {out.errors.map((e) => <li key={e} className="error">{e}</li>)}
          {out.warnings.map((e) => <li key={e} className="warning">{e}</li>)}
        </ul>
      )}
    </fieldset>
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
      Let it add a new version of the item&apos;s request
      <span className="hint">{plugin.grant && granted ? <>Allowed by {plugin.grant.by}, <Stamp ts={plugin.grant.at} /></> : "Not allowed, so what it would add is dropped."}</span>
      {error && <span className="hot">Not saved: {error}. Try again.</span>}
    </label>
  );
}
