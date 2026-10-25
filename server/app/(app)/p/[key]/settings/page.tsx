import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionsSettingsForm } from "@/components/ActionsSettingsForm";
import { JiraSettingsForm } from "@/components/JiraSettingsForm";
import { projectActions, recentRuns } from "@/lib/actions/runs";
import { db } from "@/lib/db";
import { dryRuns, loadJiraSettings } from "@/lib/jira/settings";
import { STATUSES } from "@/lib/model";
import { OWNERS_UNSET, pluginOwners } from "@/lib/checkouts";
import { projectRepos } from "@/lib/plugins/store";
import { requireUser } from "@/lib/session";
import { savePluginReposAction } from "@/app/settings-actions";

const when = (iso: string) => iso.replace("T", " ").slice(0, 16);

export default async function Settings({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  await requireUser();
  const d = await db();
  const s = await loadJiraSettings(d, key);
  if (!s) notFound();
  const repos = await projectRepos(d, key);
  const actions = (
    <>
      <div className="label section">Plugin repos</div>
      {!pluginOwners().length && <p className="hot">{OWNERS_UNSET}</p>}
      <p className="hint">Repos this project reads from GitHub and runs plugins for: these, and any a member&apos;s CLI has a checkout of
        {repos.checkouts.length ? ` (${repos.checkouts.join(", ")})` : ""}.</p>
      <form action={savePluginReposAction.bind(null, key)} className="plugin-repos">
        <textarea name="repos" rows={3} defaultValue={repos.repos.map((r) => r.repo).join("\n")} placeholder="owner/name, one per line" />
        <button type="submit">Save repos</button>
      </form>
      <div className="label section">Actions</div>
      <ActionsSettingsForm projectKey={key} actions={await projectActions(d, key)} statuses={STATUSES} />
      <div className="label section">Recent runs</div>
      <RecentRuns runs={await recentRuns(d, key)} projectKey={key} />
    </>
  );
  const state = s.serverReadOnly ? "Writes off: this server is read-only (JIRA_READ_ONLY)."
    : s.outbound.writes ? "Writes on." : "Writes off for this project.";
  const runs = await dryRuns(d, key);
  return (
    <div className="settings">
      {actions}
      <div className="label section">Jira</div>
      <p className="settings-head">
        <span>Linked issues{s.jiraProjects.length ? ` in ${s.jiraProjects.join(", ")}` : ""}</span>
        <span className={s.serverReadOnly || !s.outbound.writes ? "tag" : "tag hot"}>{state}</span>
        {s.savedBy && <span className="hint">saved by {s.savedBy}, {when(s.savedAt!)}</span>}
        {!s.jiraStatuses && s.jiraProjects.length > 0 && <span className="hot">Jira couldn't be reached, so its statuses aren't listed.</span>}
      </p>
      <JiraSettingsForm projectKey={key} outbound={s.outbound} statuses={STATUSES}
                        jiraStatuses={s.jiraStatuses} serverReadOnly={s.serverReadOnly} />
      <div className="label section">Would send</div>
      {!runs.length ? <p className="empty">Nothing yet. Moves a trigger would make show here while writes are off.</p> : (
        <div className="dry-runs">
          {runs.map((r) => (
            <div className="rrow" key={r.id}>
              <span className="hint">{when(r.at)}</span>
              <span className="tag">{r.action === "transition" ? "move" : r.action}</span>
              <span className="grow">{r.action === "transition" ? `${r.key} to ${r.status}` : `on ${r.key}`}{r.title && <span className="hint"> · {r.title}</span>}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RecentRuns({ runs, projectKey }: { runs: Awaited<ReturnType<typeof recentRuns>>; projectKey: string }) {
  if (!runs.length) return <p className="empty">No Action has run yet.</p>;
  return (
    <div className="dry-runs">
      {runs.map((r) => (
        <div className="rrow" key={r.id}>
          <span className="hint">{when(r.at)}</span>
          <span className={`tag${r.state === "failed" || r.state === "gave up" ? " hot" : ""}`}>{r.state}</span>
          <span className="grow">{r.name} · <Link href={`/p/${projectKey}/i/${r.itemId}`}>{r.itemId}</Link> <span className="hint">{r.trigger}, by {r.by}</span>
            {r.message && <span className="hint"> · {r.message}</span>}</span>
        </div>
      ))}
    </div>
  );
}
