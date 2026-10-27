"use client";
// Project settings → Automation: pick a repo, then one row per thing todo can
// do for its items, each saying whether it's on, what it last did, or the steps
// that turn it on, every one taken here. A shipped plugin's row has its switch;
// a row's settings (deploy branches, instances, credentials, grants), the
// connection a step asks for, a custom plugin's YAML and code, and its run
// history open beneath it; the project's and the repo's connections and a new
// custom plugin follow the rows. Everything saves through the /plugins API
// routes, the repo list through server actions.
import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { addPluginRepo, removePluginRepo } from "@/app/plugin-actions";
import {
  automationRows, CUSTOM_STARTER, repoChoices, splitBranches, suggestBranches, type AutomationRow, type LastRun, type RowState, type Step,
} from "@/lib/automation";
import { withBase } from "@/lib/base";
import {
  addInstance as addInstanceTo, describeConnections, describeTrigger, draftPlugin, fieldsOf, savedInstances, type InstanceDraft, type PluginDraft,
} from "@/lib/plugin-form";
import { checkCustom } from "@/lib/plugins/config";
import { configurable, connectionNotice } from "@/lib/plugin-summary";
import type { AutomationPage, DashConnection, DashCustom, DashPlugin, DashRepo, HostConnection, RepoEntry } from "@/lib/plugin-views";
import { authKind, authOf, serviceLabel, type AuthKind, type Service } from "@/lib/services";
import { ConnectionForm, connectionReady, connectionState } from "./ConnectionForm";
import { InstanceCard, RunLog, SettingInput, type NewConnection } from "./PluginInstance";
import { notify } from "./Toaster";
import { VercelPick } from "./VercelPick";
import { Ago, Stamp } from "./ui";

/** Send a write to a plugins API route; what refused it, with the status, or null when it went through. */
async function sendFor(project: string, path: string, method: "PUT" | "POST" | "DELETE", body: unknown):
    Promise<{ error: string; status: number } | null> {
  const res = await fetch(withBase(`/api/projects/${encodeURIComponent(project)}/plugins${path}`), {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }).catch(() => null);
  if (!res) return { error: "the server couldn't be reached", status: 0 };
  if (res.ok) return null;
  const err = await res.json().catch(() => null);
  return { error: err?.error ?? `the server answered ${res.status}`, status: res.status };
}

/** Send a write to a plugins API route; the error text when it's refused. */
async function send(project: string, path: string, method: "PUT" | "POST" | "DELETE", body: unknown): Promise<string | null> {
  return (await sendFor(project, path, method, body))?.error ?? null;
}

/** A save refused because someone else saved first: what changed, and a reload that shows it. */
function Stale({ message, onReload }: { message: string; onReload: () => void }) {
  return (
    <span className="hot stale">
      Not saved: {message}.{" "}
      <button type="button" className="link-btn" onClick={onReload}>Reload ›</button>
    </span>
  );
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

const STATE_LABEL: Record<RowState, string> = { on: "On", setup: "Needs setup", elsewhere: "Elsewhere", off: "Off" };

/** What the page knows of the project's connections, which a row's steps and forms read. */
interface Conns { host: HostConnection[]; services: Service[]; secretProblem: string | null }

export function AutomationSettings({ projectKey, page, statuses }: { projectKey: string; page: AutomationPage; statuses: readonly string[] }) {
  const repo = page.selected;
  const conns: Conns = { host: page.host, services: page.services, secretProblem: page.secretProblem };
  const rows = repo ? automationRows(repo, { project: projectKey, bridge: page.bridge, host: page.host, services: page.services }) : [];
  return (
    <div className="automation">
      <h1>Automation</h1>
      <p className="automation-intro">
        todo can keep items up to date from GitHub, Vercel and Jira on its own. Pick a repo to see what it does for that repo&apos;s
        items, and how to turn more on.
      </p>
      <RepoPicker projectKey={projectKey} repos={page.repos} selected={repo} />
      {repo && (
        <div className="auto-rows" data-repo={repo.repo}>
          {rows.map((r) => (
            <Row key={`${repo.repo}/${r.key}`} projectKey={projectKey} repo={repo} row={r} statuses={statuses} conns={conns} shipped={page.shipped} />
          ))}
          <AddCustom key={repo.repo} projectKey={projectKey} repo={repo} shipped={page.shipped} />
          <ProjectConnections projectKey={projectKey} repo={repo} conns={conns} />
          <Connections projectKey={projectKey} repo={repo} secretProblem={page.secretProblem} projectNames={page.host.map((h) => h.name)} />
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
      {selected && <RepoNotes repo={selected} />}
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

/** What the server can't read of the repo, and what of its config doesn't load. */
function RepoNotes({ repo }: { repo: DashRepo }) {
  if (repo.branches.visible !== false && !repo.errors.length) return null;
  return (
    <div className="repo-source">
      {repo.branches.visible === false && (
        <p className="hint">
          GitHub doesn&apos;t show {repo.repo} to {repo.github === "page" ? "this project's" : "the server's"} token, so todo can&apos;t read its
          branches, commits or pull requests.
        </p>
      )}
      {repo.errors.length > 0 && (
        <>
          <p className="hot">Some of this repo&apos;s plugin settings don&apos;t load, so their rows may be missing:</p>
          <ul className="problems">{repo.errors.map((e) => <li key={e} className="error">{e}</li>)}</ul>
        </>
      )}
    </div>
  );
}

// ── one row ───────────────────────────────────────────────────────────────────
/** A row's settings, a custom plugin's editor, its history, or the form for a connection one of its steps asks for. */
type Panel = "setup" | "edit" | "history" | `connect:${string}`;
/** Panels a person opened, kept open across the refresh a save causes. */
const opened = new Map<string, Panel>();

function hasSettings(p: DashPlugin, repo: DashRepo): boolean {
  return configurable(p) || p.capabilities.includes("post-request")
    || repo.connections.some((c) => c.usedBy.includes(p.name) && !!connectionNotice(p.shipped, c)?.form);
}

function Row({ projectKey, repo, row, statuses, conns, shipped }: {
  projectKey: string; repo: DashRepo; row: AutomationRow; statuses: readonly string[]; conns: Conns; shipped: string[];
}) {
  const id = `${repo.repo}/${row.key}`;
  const [panel, setPanelState] = useState<Panel | null>(() => opened.get(id) ?? null);
  const setPanel = (p: Panel | null) => {
    if (p) opened.set(id, p);
    else opened.delete(id);
    setPanelState(p);
  };
  const toggle = (p: Panel) => setPanel(panel === p ? null : p);
  const p = row.plugin;
  const settings = row.branches || (!!p && hasSettings(p, repo));
  const history = !!p && p.instances.length > 0;
  const showSteps = row.state === "setup" || row.state === "off";
  // A step that opens the settings stands in for the row's own link; a broken custom plugin's opens its editor.
  const stepPanel: Panel | null = settings ? "setup" : row.custom ? "edit" : null;
  const stepOpens = showSteps && !!stepPanel && row.steps.some((s) => s.setup && !s.done);
  return (
    <section className={`auto-row ${row.state}`} data-row={row.key} data-state={row.state}>
      <div className="auto-state"><span className="dot" aria-hidden />{STATE_LABEL[row.state]}</div>
      <div className="auto-body">
        <div className="auto-head">
          <span className="auto-title">{row.title}</span>
          <span className="auto-plugins">{row.plugins.join(", ")}</span>
          {row.toggle && <Switch projectKey={projectKey} repo={repo.repo} plugin={row.toggle.plugin} on={row.toggle.on} />}
        </div>
        {row.last !== undefined && (row.last ? <Last projectKey={projectKey} last={row.last} /> : row.state === "on" && <p className="auto-line faint">Hasn&apos;t run yet.</p>)}
        {row.offers && row.state === "off" && <p className="auto-line">{row.offers}</p>}
        {row.notes.map((n) => (
          <p key={n.text} className={`auto-line${n.warn ? " hot" : ""}`}>
            {n.text}{n.link && <> <Link href={n.link.href}>{n.link.label} ›</Link></>}
          </p>
        ))}
        {showSteps && row.steps.length > 0 && (
          <Steps steps={row.steps} lead={row.state === "setup" ? "To finish:" : "To turn on:"} onSetup={stepPanel ? () => setPanel(stepPanel) : null}
                 open={panel} onConnect={(name) => toggle(`connect:${name}`)} />
        )}
        {((settings && !stepOpens) || (row.custom && !(stepOpens && stepPanel === "edit")) || history) && (
          <div className="auto-actions">
            {settings && !stepOpens && (
              <button type="button" className="link-btn" aria-expanded={panel === "setup"} onClick={() => toggle("setup")}>
                {row.state === "on" ? "Settings" : "Set up"} ›
              </button>
            )}
            {row.custom && !(stepOpens && stepPanel === "edit") && (
              <button type="button" className="link-btn" aria-expanded={panel === "edit"} onClick={() => toggle("edit")}>Edit YAML ›</button>
            )}
            {history && <button type="button" className="link-btn" aria-expanded={panel === "history"} onClick={() => toggle("history")}>History ›</button>}
          </div>
        )}
        {panel?.startsWith("connect:") && (
          <div className="auto-panel connect-panel">
            <HostForm projectKey={projectKey} name={panel.slice("connect:".length)} conns={conns} onClose={() => setPanel(null)} />
          </div>
        )}
        {panel === "setup" && row.branches && <BranchesPanel key={repo.track.join(",")} projectKey={projectKey} repo={repo} />}
        {panel === "setup" && p && <SetupPanel projectKey={projectKey} repo={repo} plugin={p} statuses={statuses} conns={conns} />}
        {panel === "edit" && row.custom && (
          <CustomEditor key={`${row.custom.name}:${row.custom.updated.at}`} projectKey={projectKey} repo={repo} custom={row.custom} shipped={shipped}
                        onClose={() => setPanel(null)} />
        )}
        {p && panel === "history" && (
          <div className="auto-panel run-logs">
            {p.instances.map((i) => <RunLog key={i.id} name={i.name || i.id} rows={p.runs[i.id] ?? []} projectKey={projectKey} />)}
          </div>
        )}
      </div>
    </section>
  );
}

/** A shipped plugin's on/off switch for the repo; its instances stay while it's off. */
function Switch({ projectKey, repo, plugin, on }: { projectKey: string; repo: string; plugin: string; on: boolean }) {
  const router = useRouter();
  const [want, setWant] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => setWant(null), [on]);
  const shown = want ?? on;
  const flip = (next: boolean) => {
    // Shown at once, outside the transition, so the switch moves as it's clicked.
    setWant(next);
    start(async () => {
      const err = await send(projectKey, "/config", "PUT", { repo, [next ? "enable" : "disable"]: plugin });
      setError(err);
      if (err) setWant(null);
      else router.refresh();
    });
  };
  return (
    <label className="switch auto-switch" data-tip={error ? `Not saved: ${error}` : shown ? "Switch it off; its settings stay" : undefined}>
      <input type="checkbox" role="switch" aria-label={`${plugin} on`} checked={shown} disabled={pending} onChange={(e) => flip(e.target.checked)} />
      <span className={error ? "hot" : ""}>{error ? "Not saved" : shown ? "On" : "Off"}</span>
    </label>
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

function Steps({ steps, lead, onSetup, open, onConnect }: {
  steps: Step[]; lead: string; onSetup: (() => void) | null; open: Panel | null; onConnect: (name: string) => void;
}) {
  return (
    <div className="auto-steps">
      <span className="faint">{lead}</span>
      <ol>
        {steps.map((s, i) => (
          <li key={i} className={s.done ? "done" : ""} data-connect={s.connect}>
            <span className="step-mark" aria-label={s.done ? "done" : undefined}>{s.done ? "✓" : `${i + 1}.`}</span>
            <div className="step-body">
              {s.text}
              {s.setup && !s.done && onSetup && <> <button type="button" className="link-btn" onClick={onSetup}>Set up ›</button></>}
              {s.connect && (
                <> <button type="button" className="link-btn" aria-expanded={open === `connect:${s.connect}`} onClick={() => onConnect(s.connect!)}>
                  {s.done ? "Change" : "Set up"} ›
                </button></>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The form for one of the project's connections, filled in from what's there or the service's usual address. */
function HostForm({ projectKey, name, conns, onClose, onSaved }: {
  projectKey: string; name: string | null; conns: Conns; onClose: () => void; onSaved?: (name: string) => void;
}) {
  const current = name ? conns.host.find((h) => h.name === name) ?? null : null;
  const service = name ? conns.services.find((s) => s.name === name) ?? null : null;
  return (
    <ConnectionForm projectKey={projectKey} name={name} current={current} service={service} secretProblem={conns.secretProblem}
                    taken={conns.host.map((h) => h.name)} onCancel={onClose} onDone={(n) => { onSaved?.(n); onClose(); }} />
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

function SetupPanel({ projectKey, repo, plugin, statuses, conns }: {
  projectKey: string; repo: DashRepo; plugin: DashPlugin; statuses: readonly string[]; conns: Conns;
}) {
  // Connections a person can't act on here are the row's steps already.
  const connections = repo.connections.filter((c) => c.usedBy.includes(plugin.name) && connectionNotice(plugin.shipped, c)?.form);
  const line = cadence(plugin);
  return (
    <div className="auto-panel plugin-card" data-plugin={plugin.name}>
      {line && <p className="plugin-meta faint">{line}.</p>}
      {connections.map((c) => (connectionNotice(plugin.shipped, c)?.form === "host"
        ? <HostLine key={c.name} projectKey={projectKey} name={c.name} conns={conns} />
        : <ConnectionRow key={c.name} projectKey={projectKey} repo={repo.repo} c={c} shipped={plugin.shipped} secretProblem={conns.secretProblem} />))}
      {plugin.capabilities.includes("post-request") && <Grant projectKey={projectKey} repo={repo.repo} plugin={plugin} />}
      {configurable(plugin) && (
        <Configure key={`${JSON.stringify(plugin.instances)}:${JSON.stringify(plugin.grant)}`} projectKey={projectKey} repo={repo} plugin={plugin}
                   statuses={statuses} conns={conns} />
      )}
    </div>
  );
}

/** One of the project's connections in a line, with its form a click away. */
function HostLine({ projectKey, name, conns, label = "Connection" }: { projectKey: string; name: string; conns: Conns; label?: string }) {
  const [open, setOpen] = useState(false);
  const current = conns.host.find((h) => h.name === name) ?? null;
  const service = conns.services.find((s) => s.name === name) ?? null;
  const state = connectionState(current, service);
  return (
    <div className="conn-row host-conn" data-connection={name} data-source={current?.source ?? "none"}>
      <div className="rrow">
        {label && <span className="faint">{label}</span>}
        <span className="mono">{name}:</span>
        <span className={`grow wrap ${state.hot ? "hot" : "faint"}`}>{state.text}</span>
        <button type="button" className="btn" aria-expanded={open} onClick={() => setOpen(!open)}>
          {current?.source === "page" ? "Change" : connectionReady(current, service) ? "Use this project's own" : `Connect ${serviceLabel(conns.services, name)}`}
        </button>
      </div>
      {open && <HostForm projectKey={projectKey} name={name} conns={conns} onClose={() => setOpen(false)} />}
    </div>
  );
}

// ── deploy branches ───────────────────────────────────────────────────────────
function BranchesPanel({ projectKey, repo }: { projectKey: string; repo: DashRepo }) {
  const router = useRouter();
  const [text, setText] = useState(repo.track.join(", "));
  const [saved, setSaved] = useState<{ ok: boolean; message: string; stale?: boolean } | null>(null);
  const [pending, start] = useTransition();
  const chosen = splitBranches(text);
  const suggested = suggestBranches(repo.branches, chosen);
  const dirty = chosen.join(",") !== repo.track.join(",");
  const listId = `branches-${repo.repo.replace(/\W/g, "-")}`;
  const example = suggestBranches(repo.branches, []).slice(0, 2);
  const save = (track: string[]) => start(async () => {
    // base: the list this page shows, so the server refuses the change if someone has changed it since.
    const err = await sendFor(projectKey, "/config", "PUT", { repo: repo.repo, track, base: repo.track });
    setSaved(err ? { ok: false, message: err.error, stale: err.status === 409 } : { ok: true, message: "Saved." });
    if (!err) router.refresh();
  });
  return (
    <form className="auto-panel branches-panel" onSubmit={(e) => { e.preventDefault(); save(chosen); }}>
      <label className="field branches-field">
        <span className="field-label">Deploy branches</span>
        <input aria-label="deploy branches" list={listId} value={text} autoComplete="off"
               placeholder={`e.g. ${(example.length ? example : ["staging", "main"]).join(", ")}`}
               onChange={(e) => { setText(e.target.value); setSaved(null); }} />
      </label>
      <datalist id={listId}>{repo.branches.names.map((n) => <option key={n} value={n} />)}</datalist>
      {suggested.length > 0 && (
        <div className="branch-suggest">
          <span className="faint">On the remote:</span>
          {suggested.map((n) => (
            <button type="button" key={n} className="chip" onClick={() => { setText([...chosen, n].join(", ")); setSaved(null); }}>+ {n}</button>
          ))}
        </div>
      )}
      <p className="hint">The branches work deploys through, in the order it reaches them, with commas between. Items show whether each holds their work.</p>
      <div className="save-row">
        <button type="submit" className="btn primary" disabled={pending || !dirty}>{pending ? "Saving…" : "Save"}</button>
        {repo.track.length > 0 && <button type="button" className="btn" disabled={pending} onClick={() => { setText(""); save([]); }}>Clear</button>}
        {saved?.stale && <Stale message={saved.message} onReload={() => router.refresh()} />}
        {saved && !saved.stale && <span className={saved.ok ? "hint" : "hot"}>{saved.ok ? saved.message : `Not saved: ${saved.message}.`}</span>}
      </div>
    </form>
  );
}

// ── custom plugins ────────────────────────────────────────────────────────────
const CODE_KEY = /^code:\s*["']?([^"'#\s]+)/m;

/** A custom plugin's YAML and code, checked as it's typed with the rules a save applies. */
function CustomEditor({ projectKey, repo, custom, shipped, onClose }: {
  projectKey: string; repo: DashRepo; custom: DashCustom | null; shipped: string[]; onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(custom?.name ?? "");
  const [manifest, setManifest] = useState(custom?.manifest ?? CUSTOM_STARTER);
  const [code, setCode] = useState(custom?.code ?? "");
  const [refused, setRefused] = useState<{ error: string; status: number } | null>(null);
  const [pending, start] = useTransition();
  const reserved = useMemo(() => [...shipped, ...repo.custom.map((c) => c.name).filter((n) => n !== custom?.name)], [shipped, repo.custom, custom]);
  const check = useMemo(() => checkCustom({ name, manifest, code: code.trim() ? code : null }, { reserved, connections: repo.available.repo }),
                        [name, manifest, code, reserved, repo.available.repo]);
  const codeFile = manifest.match(CODE_KEY)?.[1] ?? null;
  const dirty = !custom || name !== custom.name || manifest !== custom.manifest || code !== (custom.code ?? "");
  const edit = (f: () => void) => { f(); setRefused(null); };
  const save = () => start(async () => {
    // base: the version this page loaded, so a save on top of someone else's is refused, not lost.
    const err = await sendFor(projectKey, "/custom", "PUT", { repo: repo.repo, name: name.trim(), manifest, code, was: custom?.name ?? null,
                                                           base: custom?.version ?? null });
    setRefused(err);
    if (!err) {
      router.refresh();
      onClose();
    }
  });
  const remove = () => start(async () => {
    if (!custom || !window.confirm(`Remove ${custom.name}? Its instances go with it.`)) return;
    setRefused(await sendFor(projectKey, "/custom", "DELETE", { repo: repo.repo, name: custom.name }));
    router.refresh();
  });
  const reload = () => { router.refresh(); onClose(); };
  return (
    <form className="auto-panel custom-editor" data-custom={custom?.name ?? "new"} onSubmit={(e) => { e.preventDefault(); save(); }}>
      <label className="field">
        <span className="field-label">Name</span>
        <input aria-label="plugin name" value={name} placeholder="e.g. notes-link" onChange={(e) => edit(() => setName(e.target.value))} />
      </label>
      <label className="code-field">
        <span className="field-label">YAML: the plugin&apos;s triggers, settings, steps and what it attaches</span>
        <textarea aria-label="plugin yaml" spellCheck={false} rows={Math.min(24, Math.max(8, manifest.split("\n").length + 1))} value={manifest}
                  onChange={(e) => edit(() => setManifest(e.target.value))} />
      </label>
      {(codeFile || code) && (
        <label className="code-field">
          <span className="field-label">Code{codeFile ? `: ${codeFile}` : ""}, a module whose run() the sandbox calls</span>
          <textarea aria-label="plugin code" spellCheck={false} rows={Math.min(24, Math.max(8, code.split("\n").length + 1))} value={code}
                    placeholder="export async function run({ item, attach }) { … }" onChange={(e) => edit(() => setCode(e.target.value))} />
        </label>
      )}
      {(check.errors.length > 0 || check.warnings.length > 0) && (
        <ul className="problems">
          {check.errors.map((e) => <li key={e} className="error">{e}</li>)}
          {check.warnings.map((e) => <li key={e} className="warning">{e}</li>)}
        </ul>
      )}
      <div className="save-row">
        <button type="submit" className="btn primary" disabled={pending || !dirty || check.errors.length > 0}>{pending ? "Saving…" : custom ? "Save" : "Add plugin"}</button>
        <button type="button" className="btn" disabled={pending} onClick={onClose}>Cancel</button>
        {custom && <button type="button" className="btn danger" disabled={pending} onClick={remove}>Remove plugin</button>}
        {refused?.status === 409 && <Stale message={`${refused.error}; reloading drops this draft`} onReload={reload} />}
        {refused && refused.status !== 409 && <span className="hot">Not saved: {refused.error}.</span>}
      </div>
    </form>
  );
}

function AddCustom({ projectKey, repo, shipped }: { projectKey: string; repo: DashRepo; shipped: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="auto-add">
      <button type="button" className="add" aria-expanded={open} onClick={() => setOpen(!open)}><span className="pl">+</span>Add a custom plugin</button>
      {open && <CustomEditor projectKey={projectKey} repo={repo} custom={null} shipped={shipped} onClose={() => setOpen(false)} />}
    </div>
  );
}

// ── connections ───────────────────────────────────────────────────────────────
const AUTHS = ["none", "bearer", "basic", "header"] as const;

/** The project's own connections, and the server's it uses until it sets its own, for plugins that ship with todo. */
function ProjectConnections({ projectKey, repo, conns }: { projectKey: string; repo: DashRepo; conns: Conns }) {
  const [adding, setAdding] = useState(false);
  return (
    <section className="auto-connections project-connections" id="project-connections">
      <div className="label sub">This project&apos;s connections</div>
      <p className="hint">
        Endpoints the plugins that ship with todo call, in every repo of this project. A token stays on the server, encrypted, and a custom plugin never gets one.
      </p>
      {conns.host.map((h) => <HostLine key={h.name} projectKey={projectKey} name={h.name} conns={conns} label="" />)}
      {adding
        ? <div className="auto-panel"><HostForm projectKey={projectKey} name={null} conns={{ ...conns, host: [...conns.host, ...repoNames(repo)] }} onClose={() => setAdding(false)} /></div>
        : <button type="button" className="add" onClick={() => setAdding(true)}><span className="pl">+</span>Add a connection</button>}
    </section>
  );
}

/** The repo's own connection names, as connections a new one of the project's can't be named after. */
const repoNames = (repo: DashRepo): HostConnection[] => repo.available.repo.map((name) => ({
  name, source: "page", kind: "http", url: null, auth: null, held: false, unreadable: false, refused: false, privateOk: null, version: null, updated: null,
}));

function Connections({ projectKey, repo, secretProblem, projectNames }: {
  projectKey: string; repo: DashRepo; secretProblem: string | null; projectNames: string[];
}) {
  const declared = repo.connections.filter((c) => c.origin === "repo");
  return (
    <section className="auto-connections" id="connections">
      <div className="label sub">This repo&apos;s connections</div>
      <p className="hint">
        Endpoints this repo&apos;s custom plugins call, and that an instance of a shipped one can name. A credential stays on the server, encrypted.
      </p>
      {declared.map((c) => (
        <ConnectionRow key={c.name} projectKey={projectKey} repo={repo.repo} c={c} shipped={false} secretProblem={secretProblem} removable />
      ))}
      <AddConnection projectKey={projectKey} repo={repo.repo} taken={declared.map((c) => c.name)} projectNames={projectNames} />
    </section>
  );
}

function AddConnection({ projectKey, repo, taken, projectNames }: { projectKey: string; repo: string; taken: string[]; projectNames: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"http" | "mcp">("http");
  const [url, setUrl] = useState("");
  const [auth, setAuth] = useState<(typeof AUTHS)[number]>("none");
  const [header, setHeader] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const clash = taken.includes(name.trim());
  const project = projectNames.includes(name.trim());
  const def = kind === "mcp" ? { mcp: { url: url.trim() } }
    : { http: { url: url.trim(), ...(auth === "none" ? {} : { auth: auth === "header" ? `header:${header.trim()}` : auth }) } };
  const add = () => start(async () => {
    const err = await send(projectKey, "/config", "PUT", { repo, connection: { name: name.trim(), def, base: null } });
    setError(err);
    if (!err) {
      setName(""); setUrl(""); setAuth("none"); setHeader(""); setOpen(false);
      router.refresh();
    }
  });
  if (!open) return <button type="button" className="add" onClick={() => setOpen(true)}><span className="pl">+</span>Add a connection</button>;
  return (
    <form className="rule-row add-connection" onSubmit={(e) => { e.preventDefault(); add(); }}>
      <input aria-label="connection name" placeholder="name, e.g. hooks" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
      <select aria-label="connection kind" value={kind} onChange={(e) => setKind(e.target.value as "http" | "mcp")}>
        <option value="http">HTTP API</option>
        <option value="mcp">MCP server</option>
      </select>
      <input aria-label="connection url" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
      {kind === "http" && (
        <select aria-label="connection auth" value={auth} onChange={(e) => setAuth(e.target.value as (typeof AUTHS)[number])}>
          <option value="none">no credential</option>
          <option value="bearer">bearer token</option>
          <option value="basic">basic (user:password)</option>
          <option value="header">a header</option>
        </select>
      )}
      {kind === "http" && auth === "header" && (
        <input aria-label="credential header" placeholder="header name, e.g. X-Api-Key" value={header} onChange={(e) => setHeader(e.target.value)} />
      )}
      <button type="submit" className="btn primary" disabled={pending || !name.trim() || !url.trim() || clash || project || (auth === "header" && !header.trim())}>Add</button>
      <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
      {clash && <span className="hot">This repo has a connection by that name.</span>}
      {project && <span className="hot">This project has its own {name.trim()}, which plugins that ship with todo use; give the repo&apos;s another name.</span>}
      {error && <span className="hot">Not saved: {error}.</span>}
    </form>
  );
}

const repoAuth = (c: DashConnection, auth: AuthKind, header: string) =>
  (c.kind === "mcp" ? { mcp: { url: "" } } : { http: { url: "", ...(authOf(auth, header) ? { auth: authOf(auth, header) } : {}) } });

function ConnectionRow({ projectKey, repo, c, shipped, secretProblem, removable = false }: {
  projectKey: string; repo: string; c: DashConnection; shipped: boolean; secretProblem: string | null; removable?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<{ error: string; status: number } | null>(null);
  const [pending, start] = useTransition();
  const notice = connectionNotice(shipped, c);
  if (!notice && !removable) return null;
  const done = () => { setOpen(false); setEditing(false); setSecret(""); router.refresh(); };
  const post = (value: string | null, endpoint = c.url) => start(async () => {
    // The endpoint shown here: the server refuses the secret if the connection has been pointed elsewhere since.
    const err = await sendFor(projectKey, "/credentials", "POST", { repo, connection: c.name, secret: value, endpoint });
    setError(err);
    if (!err) done();
  });
  const drop = () => start(async () => {
    const used = c.usedBy.length ? ` ${c.usedBy.join(", ")} call${c.usedBy.length === 1 ? "s" : ""} it.` : "";
    if (!window.confirm(`Remove the ${c.name} connection and its credential?${used}`)) return;
    const err = await sendFor(projectKey, "/config", "PUT", { repo, connection: { name: c.name, def: null, ...(c.url ? { base: c.url } : {}) } });
    setError(err);
    if (!err) router.refresh();
  });
  return (
    <div className="conn-row" data-connection={c.name}>
      <div className="rrow">
        {!removable && <span className="faint">Connection</span>}
        <span className="mono" data-tip={c.url ? `${c.kind} · ${c.url}` : undefined}>{c.name}:</span>
        {removable && c.url && <span className="mono faint conn-url">{c.kind} {c.url}</span>}
        <span className={`grow wrap ${notice?.hot ? "hot" : "faint"}`}>{notice?.text ?? (c.usedBy.length ? `Used by ${c.usedBy.join(", ")}.` : "Nothing calls it yet.")}</span>
        {notice?.form === "credential" && (
          <button type="button" className="btn" onClick={() => { setOpen(!open); setEditing(false); setError(null); }}>{c.held ? "Replace" : "Set"} credential</button>
        )}
        {notice?.form === "credential" && c.held && (
          <button type="button" className="btn danger" disabled={pending} onClick={() => post(null)}>Clear</button>
        )}
        {removable && !c.command && (
          <button type="button" className="btn" aria-label={`edit ${c.name}`} aria-expanded={editing} onClick={() => { setEditing(!editing); setOpen(false); setError(null); }}>Edit</button>
        )}
        {removable && <button type="button" className="btn danger" aria-label={`remove ${c.name}`} disabled={pending} onClick={drop}>Remove</button>}
      </div>
      {(open || editing) && secretProblem && <p className="hint hot">Credentials can&apos;t be saved here: {secretProblem}.</p>}
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
      {editing && <EditRepoConnection projectKey={projectKey} repo={repo} c={c} onDone={done} onCancel={() => setEditing(false)} />}
      {error?.status === 409 && <Stale message={error.error} onReload={() => { setError(null); router.refresh(); }} />}
      {error && error.status !== 409 && <p className="hot">Not saved: {error.error}. Try again.</p>}
    </div>
  );
}

/** A repo connection's address, auth and credential, changed in place; a new address or auth drops the stored credential. */
function EditRepoConnection({ projectKey, repo, c, onDone, onCancel }: {
  projectKey: string; repo: string; c: DashConnection; onDone: () => void; onCancel: () => void;
}) {
  const [url, setUrl] = useState(c.url ?? "");
  const start = authKind(c.needsSecret ? (c.auth ?? "bearer") : null);
  const [auth, setAuth] = useState<AuthKind>(start.kind);
  const [header, setHeader] = useState(start.header);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<{ error: string; status: number } | null>(null);
  const [pending, run] = useTransition();
  const router = useRouter();
  const shape = repoAuth(c, auth, header);
  const def = "mcp" in shape ? { mcp: { url: url.trim() } } : { http: { ...shape.http, url: url.trim() } };
  const moved = url.trim() !== (c.url ?? "") || (c.kind === "http" && authOf(auth, header) !== (c.auth ?? undefined));
  const save = () => run(async () => {
    if (moved) {
      const err = await sendFor(projectKey, "/config", "PUT", { repo, connection: { name: c.name, def, base: c.url } });
      if (err) { setError(err); return; }
    }
    if (secret && (c.kind === "mcp" || auth !== "none")) {
      const err = await sendFor(projectKey, "/credentials", "POST", { repo, connection: c.name, secret, endpoint: url.trim() });
      if (err) { setError(err); router.refresh(); return; }
    }
    onDone();
  });
  return (
    <form className="rule-row add-connection edit-connection" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <input aria-label={`${c.name} url`} placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
      {c.kind === "http" && (
        <select aria-label={`${c.name} auth`} value={auth} onChange={(e) => setAuth(e.target.value as AuthKind)}>
          <option value="none">no credential</option>
          <option value="bearer">bearer token</option>
          <option value="basic">basic (user:password)</option>
          <option value="header">a header</option>
        </select>
      )}
      {c.kind === "http" && auth === "header" && (
        <input aria-label="credential header" placeholder="header name, e.g. X-Api-Key" value={header} onChange={(e) => setHeader(e.target.value)} />
      )}
      {(c.kind === "mcp" || auth !== "none") && (
        <input type="password" autoComplete="new-password" aria-label={`${c.name} new secret`} value={secret}
               placeholder={c.held && !moved ? "stored · type to replace" : "secret, never shown again"} onChange={(e) => setSecret(e.target.value)} />
      )}
      <button type="submit" className="btn primary" disabled={pending || !url.trim() || (!moved && !secret) || (auth === "header" && !header.trim())}>Save</button>
      <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      {moved && c.held && <span className="hint">A new address or auth drops the stored credential.</span>}
      {error?.status === 409 && <Stale message={error.error} onReload={() => { router.refresh(); onCancel(); }} />}
      {error && error.status !== 409 && <span className="hot">Not saved: {error.error}.</span>}
    </form>
  );
}

/** When each plugin's settings were last saved, so the form the refreshed data remounts still says so, even after a
 * refresh that started before the save lands first. */
const justSaved = new Map<string, number>();
const SAVED_SHOWN_MS = 15_000;

function Configure({ projectKey, repo, plugin, statuses, conns }: {
  projectKey: string; repo: DashRepo; plugin: DashPlugin; statuses: readonly string[]; conns: Conns;
}) {
  const router = useRouter();
  const id = `${repo.repo}/${plugin.name}`;
  // A plugin with no instance starts with one to fill in, since that's what setting it up means.
  const [draft, setDraft] = useState<PluginDraft>(() => {
    const d = draftPlugin(plugin, plugin.instances);
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
  const vercelPick = (settings: InstanceDraft["settings"], set: (patch: InstanceDraft["settings"]) => void) => (
    <VercelPick projectKey={projectKey} repo={repo.repo} team={typeof settings.team === "string" ? settings.team : ""}
                onPick={(team, project) => set({ team, project })} />
  );
  // A shipped plugin's instance can name a connection the project adds right there.
  const newConnection: NewConnection = (onSaved, onClose) => (
    <HostForm projectKey={projectKey} name={null} conns={{ ...conns, host: [...conns.host, ...repoNames(repo)] }} onClose={onClose} onSaved={onSaved} />
  );
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
                          available={repo.available} serverRuns={live && x.storedAs ? { runs: live.server_runs, reason: live.server_runs_reason } : null}
                          newConnection={plugin.shipped ? newConnection : undefined}
                          extra={plugin.name === "vercel-preview" && plugin.shipped ? vercelPick : undefined} />
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
