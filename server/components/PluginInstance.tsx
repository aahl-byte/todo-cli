"use client";
// One plugin instance in the Automation settings: its switch, name, triggers,
// button, test mode and settings form; and an instance's run log.
import { withBase } from "@/lib/base";
import {
  ANY, TRIGGER_KINDS, canMove, connectionChoices, connectionKeysOf, describeTrigger, duplicateInstance, editInstance, fieldsOf, moveInstance,
  removeInstance,
  attachedSummary, type Field, type InstanceDraft, type PluginDraft, type SecretDraft, type TriggerDraft, type Value,
} from "@/lib/plugin-form";
import type { DashPlugin, DashRepo, RunRow } from "@/lib/plugin-views";
import type { Attachment, Call, PluginEvent } from "@/lib/plugins/types";
import { Stamp } from "./ui";

const TRIGGER_LABEL: Record<TriggerDraft["kind"], string> = {
  status: "status move", push: "push", pr: "pull request", deployment: "deployment", manual: "manual button",
};

export function InstanceCard({ plugin, draft, x, index, ordered, statuses, onChange, serverRuns, available }: {
  plugin: DashPlugin; draft: PluginDraft; x: InstanceDraft; index: number; statuses: readonly string[];
  /** Order decides which instance fires: the plugin is first-match and has several. */
  ordered: boolean;
  onChange: (d: PluginDraft) => void;
  /** Connection names an instance may pick. */
  available: DashRepo["available"];
  /** Whether this server runs the saved instance; null until it's saved. */
  serverRuns: { runs: boolean; reason: string | null } | null;
}) {
  const edit = (patch: Partial<InstanceDraft>) => onChange(editInstance(draft, x.key, patch));
  // A connection setting offers what this instance may use: a custom plugin gets the repo's connections only.
  const choices = connectionChoices(available, plugin.shipped);
  const fields = fieldsOf(plugin.settings, connectionKeysOf(plugin.connections)).filter((f) => f.scope === "instance")
    .map((f) => (f.connection ? { ...f, options: choices } : f));
  const manual = (x.inherit ? (plugin.on ?? []) : x.triggers.map((t) => t.kind)).includes("manual");
  return (
    <div className={`instance-card${x.enabled ? "" : " off"}`} data-instance={x.id}>
      <div className="rule-row">
        <label className="switch">
          <input type="checkbox" aria-label={`${x.id} on`} checked={x.enabled} onChange={(e) => edit({ enabled: e.target.checked })} />
          {x.enabled ? "on" : "off"}
        </label>
        <label className="field">
          <span className="field-label">Name</span>
          <input aria-label="name" value={x.name} onChange={(e) => edit({ name: e.target.value })} />
        </label>
        <label className="field" data-tip="unique within the plugin; todo plugin run uses it">
          <span className="field-label">Id</span>
          <input aria-label="id" value={x.id} onChange={(e) => edit({ id: e.target.value })} />
        </label>
        <label className="check">
          <input type="checkbox" aria-label={`${x.id} test mode`} checked={x.dryRun} onChange={(e) => edit({ dryRun: e.target.checked })} />
          Test mode: show what it would do without doing it
        </label>
        <span className="grow" />
        {ordered && (
          <span className="order">
            <span className="faint">#{index + 1}</span>
            <button type="button" className="x" aria-label={`move ${x.id} up`} disabled={!canMove(draft, x.key, -1)} onClick={() => onChange(moveInstance(draft, x.key, -1))}>▲</button>
            <button type="button" className="x" aria-label={`move ${x.id} down`} disabled={!canMove(draft, x.key, 1)} onClick={() => onChange(moveInstance(draft, x.key, 1))}>▼</button>
          </span>
        )}
        <button type="button" className="btn" aria-label={`duplicate ${x.id}`} onClick={() => onChange(duplicateInstance(plugin, draft, x.key))}>duplicate</button>
        <button type="button" className="btn danger" aria-label={`remove ${x.id}`} onClick={() => onChange(removeInstance(draft, x.key))}>remove</button>
      </div>
      <Triggers plugin={plugin} x={x} statuses={statuses} edit={edit} />
      {manual && (
        <label className="field">
          <span className="field-label">Button label</span>
          <input aria-label="button label" placeholder={x.name || x.id} value={x.button} onChange={(e) => edit({ button: e.target.value })} />
        </label>
      )}
      {fields.length > 0 && (
        <div className="setting-fields">
          {fields.map((f) => (
            <SettingInput key={f.key} field={f} value={x.settings[f.key]} onChange={(v) => edit({ settings: { ...x.settings, [f.key]: v } })} />
          ))}
        </div>
      )}
      {serverRuns && (
        <p className={`hint runs-where${serverRuns.runs ? "" : " cli"}`}>
          {serverRuns.runs ? "Runs on the server." : `Runs in a developer's CLI: ${serverRuns.reason}`}
        </p>
      )}
    </div>
  );
}

function Triggers({ plugin, x, statuses, edit }: { plugin: DashPlugin; x: InstanceDraft; statuses: readonly string[]; edit: (p: Partial<InstanceDraft>) => void }) {
  const own = plugin.on ?? [];
  const set = (i: number, patch: Partial<TriggerDraft>) => edit({ triggers: x.triggers.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
  const pick = (label: string, value: string, onPick: (v: string) => void) => (
    <select aria-label={label} value={value} onChange={(e) => onPick(e.target.value)}>
      <option value={ANY}>any (*)</option>
      {statuses.map((s) => <option key={s}>{s}</option>)}
    </select>
  );
  return (
    <div className="triggers">
      <label className="check">
        <input type="checkbox" aria-label={`${x.id} uses the plugin's triggers`} checked={x.inherit}
               onChange={(e) => edit({ inherit: e.target.checked })} />
        runs on the plugin&apos;s own triggers{own.length ? `: ${own.map(describeTrigger).join(", ")}` : ": none"}
      </label>
      {!x.inherit && (
        <>
          {x.triggers.map((t, i) => (
            <div className="rule-row" key={i} data-trigger={t.kind}>
              <span className="field-label">Runs on</span>
              <select aria-label="trigger" value={t.kind} onChange={(e) => set(i, { kind: e.target.value as TriggerDraft["kind"] })}>
                {TRIGGER_KINDS.map((k) => <option key={k} value={k}>{TRIGGER_LABEL[k]}</option>)}
              </select>
              {t.kind === "status" && (
                <>
                  <span className="field-label">from</span>
                  {pick("from status", t.from, (v) => set(i, { from: v }))}
                  <span className="field-label">to</span>
                  {pick("to status", t.to, (v) => set(i, { to: v }))}
                </>
              )}
              <button type="button" className="x" aria-label="remove trigger" onClick={() => edit({ triggers: x.triggers.filter((_, j) => j !== i) })}>✕</button>
            </div>
          ))}
          {!x.triggers.length && <p className="hint">No triggers: it never runs.</p>}
          <button type="button" className="add" onClick={() => edit({ triggers: [...x.triggers, { kind: "status", from: ANY, to: ANY }] })}>
            <span className="pl">+</span>trigger
          </button>
        </>
      )}
    </div>
  );
}

const isSecret = (v: Value | undefined): v is SecretDraft => !!v && typeof v === "object";

/** One setting's input, by its type. */
export function SettingInput({ field, value, onChange }: { field: Field; value: Value | undefined; onChange: (v: Value) => void }) {
  const text = typeof value === "string" ? value : "";
  let input;
  switch (field.control) {
    case "textarea":
      input = <textarea aria-label={field.label} rows={2} placeholder={field.placeholder} value={text} onChange={(e) => onChange(e.target.value)} />;
      break;
    case "list":
      input = <textarea aria-label={field.label} rows={2} placeholder={field.placeholder ?? "one per line"} value={text} onChange={(e) => onChange(e.target.value)} />;
      break;
    case "checkbox":
      input = <input type="checkbox" aria-label={field.label} checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
      break;
    case "number":
      input = <input type="number" aria-label={field.label} placeholder={field.placeholder} value={text} onChange={(e) => onChange(e.target.value)} />;
      break;
    case "select": {
      const options = field.options ?? [];
      input = (
        <select aria-label={field.label} value={text} onChange={(e) => onChange(e.target.value)}>
          <option value="">{field.placeholder ?? "—"}</option>
          {text && !options.includes(text) && <option value={text}>{text} (not an option)</option>}
          {options.map((o) => <option key={o}>{o}</option>)}
        </select>
      );
      break;
    }
    case "password":
      input = <SecretInput field={field} value={isSecret(value) ? value : { state: "unset" }} onChange={onChange} />;
      break;
    default:
      input = <input aria-label={field.label} placeholder={field.placeholder} value={text} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <div className={`setting setting-${field.type}`} data-setting={field.key}>
      <span className="setting-label">{field.label}{field.required && <span className="hot" data-tip="required"> *</span>}</span>
      <div className="setting-input">
        {input}
        {field.note && <span className="hint">{field.note}</span>}
      </div>
    </div>
  );
}

/** A secret shows only whether it's stored: left alone it's kept, typed over it's replaced, cleared it's removed on save. */
function SecretInput({ field, value, onChange }: { field: Field; value: SecretDraft; onChange: (v: Value) => void }) {
  if (value.state === "cleared") {
    return (
      <span className="secret-state">
        <span className="tag rej">cleared on save</span>
        <button type="button" className="btn" onClick={() => onChange({ state: "stored" })}>undo</button>
      </span>
    );
  }
  return (
    <span className="secret-state">
      <input type="password" autoComplete="new-password" aria-label={field.label}
             placeholder={value.state === "stored" ? "set · type to replace" : "not set"}
             value={value.state === "new" ? value.value : ""}
             onChange={(e) => onChange({ state: "new", value: e.target.value })} />
      {value.state === "stored" && <span className="tag ok">set</span>}
      {value.state === "new" && value.value && <span className="tag hot">new, stored on save</span>}
      {value.state === "stored" && (
        <button type="button" className="btn" aria-label={`clear ${field.label}`} onClick={() => onChange({ state: "cleared" })}>clear</button>
      )}
    </span>
  );
}

// ── run log ───────────────────────────────────────────────────────────────────
function eventText(e: PluginEvent): string {
  switch (e.type) {
    case "status": return `${e.from} → ${e.to}`;
    case "push": case "pr": case "deployment": return `${e.type} ${e.branch}`;
    case "manual": return "button";
    default: return e.type;
  }
}

function attachmentText(a: Attachment): string {
  switch (a.kind) {
    case "link": return `link ${a.label ? `${a.label} · ` : ""}${a.url}`;
    case "edge": return `edge needs ${a.needs}${a.in ? ` in ${a.in}` : ""}: ${a.because}`;
    case "doc": return `doc ${a.name}`;
    case "log": return `log: ${a.text}`;
    case "request": return "a new request version";
    case "comment": return `comment${a.author_name ? ` by ${a.author_name}` : ""}: ${a.text}`;
  }
}

const callText = (c: Call) => `${c.connection} ${c.tool ? `tool ${c.tool}` : `${c.method ?? "GET"} ${c.path ?? ""}`}`;

export function RunLog({ name, rows, projectKey }: { name: string; rows: RunRow[]; projectKey: string }) {
  return (
    <div className="run-log" data-instance-log={name}>
      <div className="label sub">{name}</div>
      {!rows.length && <p className="empty">No runs yet.</p>}
      {rows.map((r) => {
        const state = r.error ? "error" : r.skipped ? "skipped" : r.dryRun ? "test mode" : "ran";
        return (
          <details key={r.id} className="run-row">
            <summary className="rrow">
              <Stamp ts={r.at} />
              <span className={`tag${r.error ? " rej" : r.skipped ? " hot" : ""}`}>{state}</span>
              {r.item ? <a href={withBase(`/p/${projectKey}/i/${r.item.id}`)}>{r.item.id}</a> : <span className="faint">a removed item</span>}
              <span className="faint">{eventText(r.event)}</span>
              <span className="grow faint">
                {r.error ?? r.skipped ?? (r.dryRun ? `would send ${r.wouldSend.length}` : r.attached.length ? attachedSummary(r.attached) : "nothing attached")}
              </span>
            </summary>
            <div className="run-detail">
              {r.attached.length > 0 && <><div className="label sub">{r.dryRun ? "would attach" : "attached"}</div>
                <ul>{r.attached.map((a, i) => <li key={i}>{attachmentText(a)}</li>)}</ul></>}
              {r.wouldSend.length > 0 && <><div className="label sub">would send</div>
                <ul>{r.wouldSend.map((c, i) => <li key={i}><code>{callText(c)}</code>{c.input !== undefined && <pre>{JSON.stringify(c.input, null, 2)}</pre>}</li>)}</ul></>}
              {r.log.length > 0 && <><div className="label sub">log</div><ul>{r.log.map((l, i) => <li key={i}>{l}</li>)}</ul></>}
              {r.skipped && <p className="hot">skipped: {r.skipped}</p>}
              {r.error && <p className="hot">error: {r.error}</p>}
            </div>
          </details>
        );
      })}
    </div>
  );
}
