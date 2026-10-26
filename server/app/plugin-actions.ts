"use server";
// Plugin writes the dashboard makes as server actions: the project's repo
// allowlist, and running a manual instance from the item page. Instances,
// grants and credentials save through the /plugins API routes.
import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-helpers";
import { db } from "@/lib/db";
import { later } from "@/lib/http";
import { itemButtons, manualRunState } from "@/lib/plugin-views";
import { queuePluginEvent } from "@/lib/plugins/queue";
import { flushPluginRuns } from "@/lib/plugins/server";
import { PluginInputError, projectRepos, putProjectRepos } from "@/lib/plugins/store";
import { requireUser } from "@/lib/session";

/** How long pressing a button waits for the run before the page polls for it. */
const FIRST_WAIT_MS = 5_000;

const fail = (message: string): ActionState => ({ ok: false, message, at: Date.now() });

async function setRepos(key: string, change: (repos: string[]) => string[]): Promise<ActionState> {
  const user = await requireUser();
  const d = await db();
  const [p] = await d.query("select 1 from projects where key = $1", [key]);
  if (!p) return fail("No such project.");
  const listed = (await projectRepos(d, key)).repos.map((r) => r.repo);
  try {
    await putProjectRepos(d, key, change(listed), user.handle);
  } catch (e) {
    if (e instanceof PluginInputError) return fail(e.message);
    throw e;
  }
  revalidatePath(`/p/${key}/settings/automation`);
  return { ok: true, at: Date.now() };
}

/** List a repo for the project's plugins and git facts. */
export async function addPluginRepo(key: string, repo: string): Promise<ActionState> {
  const name = repo.trim();
  if (!name) return fail("Give a repo as owner/name.");
  return setRepos(key, (repos) => [...repos, name]);
}

/** Take a repo off the project's list; a member's checkout of it still allows it. */
export async function removePluginRepo(key: string, repo: string): Promise<ActionState> {
  return setRepos(key, (repos) => repos.filter((r) => r !== repo));
}

export type PluginRunState = ActionState & { event?: number; done?: boolean };

async function report(project: string, event: number, name: string): Promise<PluginRunState> {
  const state = await manualRunState(await db(), project, event);
  if (!state) return fail("No such run.");
  if (state.done) revalidatePath(`/p/${project}`, "layout");
  return { ok: state.ok, done: state.done, event, message: `${name}: ${state.message}`, at: Date.now() };
}

/** Queue a manual instance on the item and wait briefly for its run; the answer says whether it's done. */
export async function runPlugin(a: { project: string; itemUid: string; plugin: string; instance: string }): Promise<PluginRunState> {
  const user = await requireUser();
  const d = await db();
  const [it] = await d.query("select uid, status, extra from items where project = $1 and uid = $2", [a.project, a.itemUid]);
  if (!it) return fail("No such item.");
  const button = (await itemButtons(d, a.project, it)).find((b) => b.plugin === a.plugin && b.instance === a.instance);
  if (!button) return fail("That plugin doesn't run from here.");
  if (!button.server) return fail(`${button.label} runs in a developer's CLI: ${button.reason}`);
  const event = await queuePluginEvent(d, a.project, it.uid, it.extra?.repo, { type: "manual", instance: a.instance }, user.handle, [a.plugin]);
  if (event === null) return fail("Plugins don't run for this item.");
  const flush = flushPluginRuns(d).catch((e) => { console.error("plugins: flush failed:", e); });
  later(() => flush);
  await Promise.race([flush, new Promise((ok) => setTimeout(ok, FIRST_WAIT_MS))]);
  return report(a.project, event, button.label);
}

/** Where a run started by runPlugin stands. */
export async function pluginRun(a: { project: string; event: number; label: string }): Promise<PluginRunState> {
  await requireUser();
  const d = await db();
  const state = await report(a.project, a.event, a.label);
  if (!state.done) later(() => flushPluginRuns(d).catch(() => undefined));
  return state;
}
