"use client";
// jira-transition's settings as the Jira bridge's form lays them out: the send
// switch (test mode off), what's never moved to, a row per trigger in the order
// that decides which one runs, a move to try, and what it would have sent.
// Each row saves as one instance; a save sends the instances the page showed,
// and the server refuses it once they've changed.
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { withBase } from "@/lib/base";
import { pluginRules, ruleInstances, type PluginRules, type PluginTrigger } from "@/lib/jira/plugin-rules";
import { validateRules } from "@/lib/jira/rules";
import type { DashPlugin, RunRow } from "@/lib/plugin-views";
import { asStored } from "@/lib/plugin-summary";
import { asRules, JiraTriggers, Problems } from "./JiraSettingsForm";
import { Stamp } from "./ui";

const keptText = (t: PluginTrigger) => (t.kept ? `${t.kept.name || t.kept.id} runs on a button press, so it's kept as it is here.` : null);

/** The moves its runs in test mode would have made: newest first. */
function wouldSend(plugin: DashPlugin): { id: number; at: string; key: string; status: string; title: string | null }[] {
  const out = [];
  for (const i of plugin.instances) {
    const to = typeof i.settings?.to === "string" ? i.settings.to : "?";
    for (const r of plugin.runs[i.id] ?? ([] as RunRow[])) {
      for (const c of r.wouldSend) {
        const key = c.method === "POST" ? c.path?.match(/\/issue\/([^/]+)\/transitions$/)?.[1] : null;
        if (key) out.push({ id: r.id, at: r.at, key: decodeURIComponent(key), status: to, title: r.item?.title ?? null });
      }
    }
  }
  return out.sort((a, b) => b.id - a.id).slice(0, 20);
}

/** When each repo's jira-transition was last saved, so the editor the refreshed data remounts still says so. */
const justSaved = new Map<string, number>();
const SAVED_SHOWN_MS = 15_000;

export function JiraTransitionEditor({ projectKey, repo, plugin, statuses, sendLock }: {
  projectKey: string; repo: string; plugin: DashPlugin; statuses: readonly string[];
  /** Why sending is locked off, or null when it can be switched. */
  sendLock: string | null;
}) {
  const router = useRouter();
  const seen = useMemo(() => plugin.instances.map(asStored), [plugin.instances]);
  const [rules, setRules] = useState<PluginRules>(() => pluginRules(seen));
  const [dirty, setDirty] = useState(false);
  const [jira, setJira] = useState<{ statuses: string[] | null; error: string | null } | null>(null);
  const [saved, setSaved] = useState<{ ok: boolean; message: string; stale?: boolean } | null>(
    () => (Date.now() - (justSaved.get(repo) ?? 0) < SAVED_SHOWN_MS ? { ok: true, message: "Saved." } : null));
  const [pending, start] = useTransition();
  // Between a save and the refreshed data the editor is locked, since the new data remounts it.
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(withBase(`/api/projects/${encodeURIComponent(projectKey)}/plugins/jira?repo=${encodeURIComponent(repo)}`))
      .then((r) => (r.ok ? r.json() : { statuses: null, error: `the server answered ${r.status}` }))
      .catch(() => ({ statuses: null, error: "the server couldn't be reached" }))
      .then((j) => { if (live) setJira(j); });
    return () => { live = false; };
  }, [projectKey, repo]);
  const problems = useMemo(() => validateRules(asRules(rules, (t) => !t.kept), statuses, jira?.statuses, { any: true }), [rules, statuses, jira]);
  const errors = problems.filter((p) => p.level === "error");
  const save = () => start(async () => {
    const res = await fetch(withBase(`/api/projects/${encodeURIComponent(projectKey)}/plugins`), {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo, plugin: plugin.name, instances: ruleInstances(rules), base: seen }),
    }).catch(() => null);
    if (res?.ok) {
      setSaved({ ok: true, message: "Saved." });
      setDirty(false);
      setRefreshing(true);
      justSaved.set(repo, Date.now());
      router.refresh();
      return;
    }
    const err = res ? await res.json().catch(() => null) : null;
    setSaved({ ok: false, message: err?.error ?? (res ? `the server answered ${res.status}` : "the server couldn't be reached"), stale: res?.status === 409 });
  });
  const sent = wouldSend(plugin);
  return (
    <fieldset className="jira-settings plugin-jira" data-plugin-editor="jira-transition" disabled={pending || refreshing}>
      {jira && !jira.statuses && <p className="hot">Jira couldn&apos;t be reached, so its statuses aren&apos;t listed: {jira.error}.</p>}
      <JiraTriggers value={rules} onChange={(v) => { setRules(v); setDirty(true); setSaved(null); justSaved.delete(repo); }} statuses={statuses}
                    jiraStatuses={jira?.statuses ?? null} sendLock={sendLock} ordered any kept={keptText}
                    blank={() => ({ from: "", to: "", jira: "" })} />
      <Problems problems={problems} />
      <div className="save-row">
        <button type="button" className="btn primary" disabled={pending || !dirty || errors.length > 0} onClick={save}>{pending ? "Saving…" : "Save"}</button>
        {saved?.ok && <span className="hint">{saved.message}</span>}
        {saved && !saved.ok && (
          <span className="hot">
            Not saved: {saved.message}.{saved.stale && <> <button type="button" className="link-btn" onClick={() => router.refresh()}>Reload ›</button></>}
          </span>
        )}
      </div>
      <div className="label sub">Would send</div>
      {!sent.length ? <p className="empty">Nothing yet. Moves a trigger would make show here while sending is off.</p> : (
        <div className="dry-runs">
          {sent.map((r, i) => (
            <div className="rrow" key={`${r.id}-${i}`}>
              <span className="hint"><Stamp ts={r.at} /></span>
              <span className="tag">move</span>
              <span className="grow">{r.key} to {r.status}{r.title && <span className="hint"> · {r.title}</span>}</span>
            </div>
          ))}
        </div>
      )}
    </fieldset>
  );
}
