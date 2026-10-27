"use client";
// watchtower-session's and rest's buttons as the General tab lays out an
// Action: a card per button with its fields, and the status moves it fires on
// by itself. A save sends the instances the page showed, and the server
// refuses it once they've changed.
import { useMemo, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { withBase } from "@/lib/base";
import { ANY_STATUS, METHODS } from "@/lib/actions/model";
import {
  BODYLESS, blankCard, cardsOf, instancesOf, MODELS, PLUGIN_TEMPLATE_GROUPS, WATCHTOWER, type ActionCard, type CardPlugin,
} from "@/lib/action-cards";
import { connectionChoices } from "@/lib/plugin-form";
import type { DashPlugin, DashRepo } from "@/lib/plugin-views";
import { TemplateReference } from "./ActionsSettingsForm";
import { asStored } from "./JiraTransitionEditor";
import type { NewConnection } from "./PluginInstance";

// No connection name starts with "+", so this never stands for one.
const NEW = "+new";

const HEAD: Record<CardPlugin, ReactNode> = {
  [WATCHTOWER]: (
    <>
      <div className="label sub">Watchtower</div>
      <p className="hint">
        The Watchtower plugin: each button hands the item to its Claude session in Watchtower, from the item page or on its own when the item
        makes one of its status moves. Its fields take templates filled from the item.
      </p>
    </>
  ),
  rest: (
    <>
      <div className="label sub">Web requests</div>
      <p className="hint">
        Each button sends a web request to any URL, from the item page or on its own when the item makes one of its status moves. The path,
        headers and body take templates filled from the item: URL-encoded in the path, value by value in a JSON body.
      </p>
    </>
  ),
};

/** When each repo's plugin was last saved, so the editor the refreshed data remounts still says so. */
const justSaved = new Map<string, number>();
const SAVED_SHOWN_MS = 15_000;

export function ActionPluginEditor({ projectKey, repo, plugin, statuses, newConnection }: {
  projectKey: string; repo: DashRepo; plugin: DashPlugin & { name: CardPlugin }; statuses: readonly string[]; newConnection: NewConnection;
}) {
  const router = useRouter();
  const kind = plugin.name;
  const seen = useMemo(() => plugin.instances.map(asStored), [plugin.instances]);
  const [cards, setCards] = useState<ActionCard[]>(() => cardsOf(kind, seen));
  const [dirty, setDirty] = useState(false);
  const id = `${repo.repo}/${kind}`;
  const [saved, setSaved] = useState<{ ok: boolean; message: string; stale?: boolean } | null>(
    () => (Date.now() - (justSaved.get(id) ?? 0) < SAVED_SHOWN_MS ? { ok: true, message: "Saved." } : null));
  const [pending, start] = useTransition();
  // Between a save and the refreshed data the editor is locked, since the new data remounts it.
  const [refreshing, setRefreshing] = useState(false);
  const out = useMemo(() => instancesOf(kind, cards), [kind, cards]);
  const change = (next: ActionCard[]) => { setCards(next); setDirty(true); setSaved(null); justSaved.delete(id); };
  const edit = (i: number, patch: Partial<ActionCard>) => change(cards.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const swap = (i: number, j: number) => {
    const list = [...cards];
    [list[i], list[j]] = [list[j], list[i]];
    change(list);
  };
  const save = () => start(async () => {
    const res = await fetch(withBase(`/api/projects/${encodeURIComponent(projectKey)}/plugins`), {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ repo: repo.repo, plugin: kind, instances: out.instances, base: seen }),
    }).catch(() => null);
    if (res?.ok) {
      setSaved({ ok: true, message: "Saved." });
      setDirty(false);
      setRefreshing(true);
      justSaved.set(id, Date.now());
      router.refresh();
      return;
    }
    const err = res ? await res.json().catch(() => null) : null;
    setSaved({ ok: false, message: err?.error ?? (res ? `the server answered ${res.status}` : "the server couldn't be reached"), stale: res?.status === 409 });
  });
  return (
    <fieldset className="actions-settings plugin-actions" data-plugin-editor={kind} disabled={pending || refreshing}>
      {HEAD[kind]}
      <TemplateReference groups={PLUGIN_TEMPLATE_GROUPS}
                         hint={<>Write <code>{"{{name}}"}</code>; where it lands decides how it&apos;s filled. Click a name to copy it.</>} />
      {cards.map((c, i) => (
        <Card key={c.key} kind={kind} card={c} index={i} count={cards.length} statuses={statuses} repo={repo} newConnection={newConnection}
              edit={(patch) => edit(i, patch)} swap={swap} remove={() => change(cards.filter((_, j) => j !== i))} />
      ))}
      <button type="button" className="add" onClick={() => change([...cards, blankCard(kind)])}><span className="pl">+</span>button</button>
      {(out.errors.length > 0 || out.warnings.length > 0) && (
        <ul className="problems">
          {out.errors.map((e) => <li key={e} className="error">{e}</li>)}
          {out.warnings.map((e) => <li key={e} className="warning">{e}</li>)}
        </ul>
      )}
      <div className="save-row">
        <button type="button" className="btn primary" disabled={pending || !dirty || out.errors.length > 0} onClick={save}>{pending ? "Saving…" : "Save"}</button>
        {saved?.ok && <span className="hint">{saved.message}</span>}
        {saved && !saved.ok && (
          <span className="hot">
            Not saved: {saved.message}.{saved.stale && <> <button type="button" className="link-btn" onClick={() => router.refresh()}>Reload ›</button></>}
          </span>
        )}
      </div>
    </fieldset>
  );
}

function Card({ kind, card: c, index, count, statuses, repo, newConnection, edit, swap, remove }: {
  kind: CardPlugin; card: ActionCard; index: number; count: number; statuses: readonly string[]; repo: DashRepo; newConnection: NewConnection;
  edit: (patch: Partial<ActionCard>) => void; swap: (i: number, j: number) => void; remove: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const v = c.values;
  const set = (k: string, value: string) => edit({ values: { ...v, [k]: value } });
  const choices = connectionChoices(repo.available, true);
  const label = c.name || c.id || "button";
  return (
    <section className="action-card" data-card={c.id ?? "new"}>
      <div className="rule-row">
        <input aria-label="button name" placeholder="button name" value={c.name} onChange={(e) => edit({ name: e.target.value })} />
        <label className="check">
          <input type="checkbox" aria-label={`${label} test mode`} checked={c.dryRun} onChange={(e) => edit({ dryRun: e.target.checked })} />
          test mode
        </label>
        <span className="grow" />
        {count > 1 && (
          <span className="order">
            <button type="button" className="x" aria-label={`move ${label} up`} disabled={index === 0} onClick={() => swap(index, index - 1)}>▲</button>
            <button type="button" className="x" aria-label={`move ${label} down`} disabled={index === count - 1} onClick={() => swap(index, index + 1)}>▼</button>
          </span>
        )}
        <button type="button" className="x" aria-label={`remove ${label}`} onClick={remove}>✕</button>
      </div>
      {c.loaded?.enabled === false && <p className="hint">Switched off: it shows no button and fires on nothing until it&apos;s switched on.</p>}
      {kind === WATCHTOWER ? (
        <>
          <div className="rule-row">
            <input aria-label="folder" className="grow" placeholder="{{item.dir}}" value={v.dir} onChange={(e) => set("dir", e.target.value)} />
            <select aria-label="model" value={v.model} onChange={(e) => set("model", e.target.value)}>
              <option value="">default model</option>
              {MODELS.map((m) => <option key={m}>{m}</option>)}
            </select>
          </div>
          <label className="check">
            <input type="checkbox" checked={c.resume} onChange={(e) => edit({ resume: e.target.checked, values: { ...v, resumePrompt: v.resumePrompt || "/todo {{item.id}}" } })} />
            resume the item&apos;s last session instead of starting a new one
          </label>
          <div className="label sub">{c.resume ? "Start prompt: a new session" : "Prompt"}</div>
          <textarea aria-label="prompt" rows={2} value={v.prompt} onChange={(e) => set("prompt", e.target.value)} />
          {c.resume && (
            <>
              <div className="label sub">Resume prompt: a live or resumed session</div>
              <textarea aria-label="resume prompt" rows={2} value={v.resumePrompt} onChange={(e) => set("resumePrompt", e.target.value)} />
            </>
          )}
          <p className="hint">
            {c.resume
              ? <>Messages the live session named <code>todo: &lt;item id&gt;</code>, else resumes its last stopped one with its history, else starts one in the folder.</>
              : <>Reuses the live session named <code>todo: &lt;item id&gt;</code>, or starts one in the folder.</>}
          </p>
          <input aria-label="watchtower address for session links" placeholder="Watchtower address for session links (optional)" value={v.link}
                 onChange={(e) => set("link", e.target.value)} />
        </>
      ) : (
        <>
          <div className="rule-row">
            <select aria-label="method" value={v.method} onChange={(e) => set("method", e.target.value)}>
              {METHODS.map((m) => <option key={m}>{m}</option>)}
            </select>
            <select aria-label="connection" value={v.connection} onChange={(e) => (e.target.value === NEW ? setAdding(true) : set("connection", e.target.value))}>
              <option value="">connection…</option>
              {v.connection && !choices.includes(v.connection) && <option value={v.connection}>{v.connection} (not a connection)</option>}
              {choices.map((o) => <option key={o}>{o}</option>)}
              <option value={NEW}>+ New connection…</option>
            </select>
            <input aria-label="path" className="grow" placeholder="/path/{{item.id}}?from={{event.from}}" value={v.path} onChange={(e) => set("path", e.target.value)} />
          </div>
          {adding && <div className="auto-panel new-connection">{newConnection((name) => set("connection", name), () => setAdding(false))}</div>}
          <textarea aria-label="headers" rows={2} placeholder="Header: value, one per line" value={v.headers} onChange={(e) => set("headers", e.target.value)} />
          {!BODYLESS.includes(v.method) && (
            <textarea aria-label="body" rows={3} placeholder='{"item": "{{item.id}}"}' value={v.body} onChange={(e) => set("body", e.target.value)} />
          )}
        </>
      )}
      <div className="label sub">Fires on its own when an item moves</div>
      <div className="rule-table">
        {c.auto.map((r, k) => (
          <div className="rule-row" key={k}>
            <select aria-label="from status" value={r.from} onChange={(e) => edit({ auto: c.auto.map((x, j) => (j === k ? { ...x, from: e.target.value } : x)) })}>
              <option value={ANY_STATUS}>any status</option>
              {statuses.map((s) => <option key={s}>{s}</option>)}
            </select>
            <span className="arrow">→</span>
            <select aria-label="to status" value={r.to} onChange={(e) => edit({ auto: c.auto.map((x, j) => (j === k ? { ...x, to: e.target.value } : x)) })}>
              {!r.to && <option value="">—</option>}
              {r.to === ANY_STATUS && <option value={ANY_STATUS}>any status</option>}
              {statuses.map((s) => <option key={s}>{s}</option>)}
            </select>
            <button type="button" className="x" aria-label="remove move" onClick={() => edit({ auto: c.auto.filter((_, j) => j !== k) })}>✕</button>
          </div>
        ))}
      </div>
      <button type="button" className="add" onClick={() => edit({ auto: [...c.auto, { from: ANY_STATUS, to: "" }] })}><span className="pl">+</span>status move</button>
    </section>
  );
}
