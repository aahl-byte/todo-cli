"use client";
// Project settings → Automation: pick a repo, then one row per thing todo can
// do for its items, each saying whether it's on, what it last did, or the steps
// that turn it on and who takes them. A shipped plugin's row has its switch; a
// row's settings (deploy branches, instances, credentials, grants), a custom
// plugin's YAML and code, and its run history open beneath it; the repo's
// connections and a new custom plugin follow the rows. Everything saves through
// the /plugins API routes, the repo list through server actions.
import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { addPluginRepo, removePluginRepo } from "@/app/plugin-actions";
import {
  automationRows, CUSTOM_STARTER, repoChoices, splitBranches, suggestBranches, WHO, type AutomationRow, type LastRun, type RowState, type Step,
} from "@/lib/automation";
import { withBase } from "@/lib/base";
import { addInstance as addInstanceTo, describeConnections, describeTrigger, draftPlugin, fieldsOf, savedInstances, type PluginDraft } from "@/lib/plugin-form";
import { checkCustom } from "@/lib/plugins/config";
import { configurable, connectionNotice } from "@/lib/plugin-summary";
import type { AutomationPage, DashConnection, DashCustom, DashPlugin, DashRepo, RepoEntry } from "@/lib/plugin-views";
import { InstanceCard, RunLog, SettingInput } from "./PluginInstance";
import { notify } from "./Toaster";
import { Ago, Stamp } from "./ui";

/** Send a write to a plugins API route; the error text when it's refused. */
async function send(project: string, path: string, method: "PUT" | "POST" | "DELETE", body: unknown): Promise<string | null> {
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
            <Row key={`${repo.repo}/${r.key}`} projectKey={projectKey} repo={repo} row={r} statuses={statuses} secretKeySet={secretKeySet}
                 shipped={page.shipped} />
          ))}
          <AddCustom key={repo.repo} projectKey={projectKey} repo={repo} shipped={page.shipped} />
          <Connections projectKey={projectKey} repo={repo} secretKeySet={secretKeySet} />
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
        <p className="hint">GitHub doesn&apos;t show {repo.repo} to the server, so todo can&apos;t read its branches, commits or pull requests.</p>
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
type Panel = "setup" | "edit" | "history";
/** Panels a person opened, kept open across the refresh a save causes. */
const opened = new Map<string, Panel>();

function hasSettings(p: DashPlugin, repo: DashRepo): boolean {
  return configurable(p) || p.capabilities.includes("post-request")
    || repo.connections.some((c) => c.usedBy.includes(p.name) && !!connectionNotice(p.shipped, c)?.form);
}

function Row({ projectKey, repo, row, statuses, secretKeySet, shipped }: {
  projectKey: string; repo: DashRepo; row: AutomationRow; statuses: readonly string[]; secretKeySet: boolean; shipped: string[];
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
          <Steps steps={row.steps} lead={row.state === "setup" ? "To finish:" : "To turn on:"} onSetup={stepPanel ? () => setPanel(stepPanel) : null} />
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
        {panel === "setup" && row.branches && <BranchesPanel key={repo.track.join(",")} projectKey={projectKey} repo={repo} />}
        {panel === "setup" && p && <SetupPanel projectKey={projectKey} repo={repo} plugin={p} statuses={statuses} secretKeySet={secretKeySet} />}
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
              {s.code && <div className="step-env">{s.code.split("\n").map((v) => <code key={v} className="env">{v}</code>)}</div>}
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

// ── deploy branches ───────────────────────────────────────────────────────────
function BranchesPanel({ projectKey, repo }: { projectKey: string; repo: DashRepo }) {
  const router = useRouter();
  const [text, setText] = useState(repo.track.join(", "));
  const [saved, setSaved] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, start] = useTransition();
  const chosen = splitBranches(text);
  const suggested = suggestBranches(repo.branches, chosen);
  const dirty = chosen.join(",") !== repo.track.join(",");
  const listId = `branches-${repo.repo.replace(/\W/g, "-")}`;
  const example = suggestBranches(repo.branches, []).slice(0, 2);
  const save = (track: string[]) => start(async () => {
    const err = await send(projectKey, "/config", "PUT", { repo: repo.repo, track });
    setSaved(err ? { ok: false, message: err } : { ok: true, message: "Saved." });
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
        {saved && <span className={saved.ok ? "hint" : "hot"}>{saved.ok ? saved.message : `Not saved: ${saved.message}.`}</span>}
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
  const [refused, setRefused] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const reserved = useMemo(() => [...shipped, ...repo.custom.map((c) => c.name).filter((n) => n !== custom?.name)], [shipped, repo.custom, custom]);
  const check = useMemo(() => checkCustom({ name, manifest, code: code.trim() ? code : null }, { reserved, connections: repo.available.repo }),
                        [name, manifest, code, reserved, repo.available.repo]);
  const codeFile = manifest.match(CODE_KEY)?.[1] ?? null;
  const dirty = !custom || name !== custom.name || manifest !== custom.manifest || code !== (custom.code ?? "");
  const edit = (f: () => void) => { f(); setRefused(null); };
  const save = () => start(async () => {
    const err = await send(projectKey, "/custom", "PUT", { repo: repo.repo, name: name.trim(), manifest, code, was: custom?.name ?? null });
    setRefused(err);
    if (!err) {
      router.refresh();
      onClose();
    }
  });
  const remove = () => start(async () => {
    if (!custom || !window.confirm(`Remove ${custom.name}? Its instances go with it.`)) return;
    const err = await send(projectKey, "/custom", "DELETE", { repo: repo.repo, name: custom.name });
    setRefused(err);
    if (!err) router.refresh();
  });
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
        {refused && <span className="hot">Not saved: {refused}.</span>}
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

function Connections({ projectKey, repo, secretKeySet }: { projectKey: string; repo: DashRepo; secretKeySet: boolean }) {
  const declared = repo.connections.filter((c) => c.origin === "repo");
  return (
    <section className="auto-connections" id="connections">
      <div className="label sub">Connections</div>
      <p className="hint">
        Endpoints this repo&apos;s custom plugins call, and that an instance of a shipped one can name. A credential stays on the server, encrypted.
      </p>
      {declared.map((c) => (
        <ConnectionRow key={c.name} projectKey={projectKey} repo={repo.repo} c={c} shipped={false} secretKeySet={secretKeySet} removable />
      ))}
      <AddConnection projectKey={projectKey} repo={repo.repo} taken={declared.map((c) => c.name)} />
    </section>
  );
}

function AddConnection({ projectKey, repo, taken }: { projectKey: string; repo: string; taken: string[] }) {
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
  const def = kind === "mcp" ? { mcp: { url: url.trim() } }
    : { http: { url: url.trim(), ...(auth === "none" ? {} : { auth: auth === "header" ? `header:${header.trim()}` : auth }) } };
  const add = () => start(async () => {
    const err = await send(projectKey, "/config", "PUT", { repo, connection: { name: name.trim(), def } });
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
      <button type="submit" className="btn primary" disabled={pending || !name.trim() || !url.trim() || clash || (auth === "header" && !header.trim())}>Add</button>
      <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
      {clash && <span className="hot">This repo has a connection by that name.</span>}
      {error && <span className="hot">Not saved: {error}.</span>}
    </form>
  );
}

function ConnectionRow({ projectKey, repo, c, shipped, secretKeySet, removable = false }: {
  projectKey: string; repo: string; c: DashConnection; shipped: boolean; secretKeySet: boolean; removable?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const notice = connectionNotice(shipped, c);
  if (!notice && !removable) return null;
  const post = (value: string | null) => start(async () => {
    const err = await send(projectKey, "/credentials", "POST", { repo, connection: c.name, secret: value });
    setError(err);
    if (!err) {
      setOpen(false);
      setSecret("");
      router.refresh();
    }
  });
  const drop = () => start(async () => {
    const used = c.usedBy.length ? ` ${c.usedBy.join(", ")} call${c.usedBy.length === 1 ? "s" : ""} it.` : "";
    if (!window.confirm(`Remove the ${c.name} connection and its credential?${used}`)) return;
    const err = await send(projectKey, "/config", "PUT", { repo, connection: { name: c.name, def: null } });
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
        {notice?.form && (
          <button type="button" className="btn" onClick={() => { setOpen(!open); setError(null); }}>{c.held ? "Replace" : "Set"} credential</button>
        )}
        {notice?.form && c.held && (
          <button type="button" className="btn danger" disabled={pending} onClick={() => post(null)}>Clear</button>
        )}
        {removable && <button type="button" className="btn danger" aria-label={`remove ${c.name}`} disabled={pending} onClick={drop}>Remove</button>}
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
