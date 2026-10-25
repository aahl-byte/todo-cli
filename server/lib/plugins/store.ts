// What the server keeps for plugins, per project and repo: each repo's
// .todo-plugins/ read from its default branch, the instances and grants people
// set, connection credentials and secret settings (encrypted), and which repos
// a project may use at all.
import type { Db, Row } from "../db";
import { repoKey } from "../checkouts";
import { PLUGINS_DIR, githubGet, NotFound, repoFile, type Fetch } from "../gitfacts";
import { githubApi } from "../github";
import { addressAllowed, type AddressGuard } from "./connections";
import { allInstances, pluginsFor, type Resolved } from "./host";
import { pluginsEnabled } from "./queue";
import { checkFile, parsePlugins } from "./load";
import { decryptSecret, encryptSecret, NoSecretKey, secretKey } from "./secrets";
import { ALWAYS_ON } from "./shipped";
import { POST_REQUEST, type ConnectionDef, type InstanceDef, type PluginDef, type PluginsFile, type RunResult, type Trigger } from "./types";

const PLUGINS_YAML = "plugins.yaml";
const CAPABILITIES = [POST_REQUEST];
const CONNECTION_NAME = /^[A-Za-z][\w-]*$/;
/** What GET shows for a secret setting that has a value. */
export const SECRET_SET = { set: true } as const;

const isMap = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class PluginInputError extends Error {}

// ── definitions ───────────────────────────────────────────────────────────────
export interface RepoDefs {
  /** plugins.yaml, or undefined when the default branch has none. */
  text?: string;
  /** The code files it names, by name. */
  files: Record<string, string>;
  sha: string | null;
  defaultBranch: string | null;
}

function defsOf(row: Row): RepoDefs {
  const { [PLUGINS_YAML]: text, ...files } = (row.files ?? {}) as Record<string, string>;
  return { text, files, sha: row.sha ?? null, defaultBranch: row.default_branch ?? null };
}

/** The repo's plugin files from its default branch, read again only once its head has moved. `repo` must be a repoKey. */
export async function loadDefs(d: Pick<Db, "query">, repo: string, f: Fetch = fetch): Promise<RepoDefs> {
  if (!repo || repoKey(repo) !== repo) throw new PluginInputError(`not a GitHub owner/name: ${repo}`);
  const [row] = await d.query("select * from plugin_defs where repo = $1", [repo]);
  if (row && !row.stale) return defsOf(row);
  const [owner, name] = repo.split("/");
  let sha: string | null = null;
  let defaultBranch: string | null = null;
  const files: Record<string, string> = {};
  try {
    defaultBranch = (await githubGet(`/repos/${owner}/${name}`, f)).default_branch ?? "main";
    sha = String((await githubGet(`/repos/${owner}/${name}/branches/${encodeURIComponent(defaultBranch!)}`, f)).commit.sha);
  } catch (e) {
    // A repo this token can't see runs only the shipped plugins.
    if (!(e instanceof NotFound)) throw e;
  }
  if (row && sha && row.sha === sha) {
    await d.query("update plugin_defs set stale = false, fetched_at = now() where repo = $1", [repo]);
    return defsOf(row);
  }
  if (sha) {
    const text = await repoFile(owner, name, `${PLUGINS_DIR}/${PLUGINS_YAML}`, sha, f);
    if (text !== null) {
      files[PLUGINS_YAML] = text;
      for (const def of Object.values(parsePlugins(text, { extraPlugins: ALWAYS_ON }).file.plugins ?? {})) {
        if (!def.code || def.code in files) continue;
        const code = await repoFile(owner, name, `${PLUGINS_DIR}/${def.code}`, sha, f);
        if (code !== null) files[def.code] = code;
      }
    }
  }
  const [saved] = await d.query(
    `insert into plugin_defs (repo, sha, default_branch, files, stale, fetched_at) values ($1, $2, $3, $4::jsonb, false, now())
     on conflict (repo) do update set sha = excluded.sha, default_branch = excluded.default_branch, files = excluded.files,
       stale = false, fetched_at = excluded.fetched_at
     returning *`, [repo, sha, defaultBranch, JSON.stringify(files)]);
  return defsOf(saved);
}

export async function invalidateDefs(d: Pick<Db, "query">, repo: string): Promise<void> {
  await d.query("update plugin_defs set stale = true where repo = $1", [repo]);
}

// ── the plugin list ───────────────────────────────────────────────────────────
export interface PluginInfo {
  name: string;
  connections: string[];
  on: Trigger[];
  every: string | null;
  settings: PluginDef["settings"];
  instances: InstanceDef[];
  shipped: boolean;
}

export interface Merged { file: PluginsFile; resolved: Resolved[]; plugins: PluginInfo[]; errors: string[] }

/** The plugins a repo runs: shipped ones and the repo file's, with every instance, switched off or not. */
export function merge(defs: RepoDefs, stored: Record<string, InstanceDef[]>): Merged {
  const errors: string[] = [];
  let file: PluginsFile = {};
  let dropped: string[] = [];
  if (defs.text !== undefined) {
    const loaded = parsePlugins(defs.text, { extraPlugins: ALWAYS_ON });
    file = loaded.file;
    dropped = loaded.droppedInstances;
    errors.push(...loaded.errors);
  }
  const resolved = pluginsFor({ repo: defs.text === undefined ? undefined : { text: defs.text, files: defs.files } }, file, errors);
  const plugins = resolved.map(({ name, def, shipped }) => ({
    name, connections: def.connections ?? [], on: def.on ?? [], every: def.every ?? null, settings: def.settings ?? {},
    instances: allInstances(def, file.instances?.[name] ?? [], stored[name] ?? [], dropped.includes(name)), shipped,
  }));
  return { file, resolved, plugins, errors };
}

const secretKeysOf = (settings: PluginDef["settings"]) =>
  Object.entries(settings ?? {}).filter(([, s]) => s.type === "secret").map(([k]) => k);

/** An instance as people may see it: each secret setting that has a value shows only that it's set. */
function masked(inst: InstanceDef, keys: string[]): InstanceDef {
  const given = inst.settings ?? {};
  if (!keys.some((k) => given[k] !== undefined && given[k] !== null)) return inst;
  const settings = { ...given };
  for (const k of keys) if (settings[k] !== undefined && settings[k] !== null) settings[k] = SECRET_SET;
  return { ...inst, settings };
}

// ── instances and grants ──────────────────────────────────────────────────────
const settingsScope = (project: string, repo: string, plugin: string, id: string) => [project, repo, plugin, id, "settings"];

/** Stored instances by plugin. With `secrets`, secret settings are decrypted into them, when the key allows. */
export async function storedInstances(d: Pick<Db, "query">, project: string, repo: string, opts: { secrets?: boolean } = {}):
    Promise<Record<string, InstanceDef[]>> {
  const rows = await d.query(
    "select plugin, id, def, secret_keys, secrets_enc from plugin_instances where project = $1 and repo = $2 order by plugin, position, id",
    [project, repo]);
  const key = opts.secrets ? secretKey() : null;
  const out: Record<string, InstanceDef[]> = {};
  for (const r of rows) {
    const def: InstanceDef = { ...r.def };
    if (r.secret_keys?.length) {
      const plain = key && r.secrets_enc ? decryptSecret(r.secrets_enc, settingsScope(project, repo, r.plugin, r.id), key) : null;
      const values = opts.secrets ? (plain ? JSON.parse(plain) : {}) : Object.fromEntries(r.secret_keys.map((k: string) => [k, SECRET_SET]));
      def.settings = { ...def.settings, ...values };
    }
    (out[r.plugin] ??= []).push(def);
  }
  return out;
}

export async function storedGrants(d: Pick<Db, "query">, project: string, repo: string): Promise<Record<string, string[]>> {
  const rows = await d.query("select plugin, capabilities from plugin_grants where project = $1 and repo = $2", [project, repo]);
  return Object.fromEntries(rows.map((r) => [r.plugin, r.capabilities ?? []]));
}

/** Split an instance's secret settings out of it: null clears one, {set: true} keeps the stored value. */
function splitSecrets(inst: InstanceDef, keys: string[], before: Record<string, string>): { def: InstanceDef; secrets: Record<string, string> } {
  const settings = { ...(inst.settings ?? {}) };
  const secrets: Record<string, string> = {};
  for (const k of keys) {
    const v = settings[k];
    delete settings[k];
    if (v === null) continue;
    if (v === undefined || (isMap(v) && v.set === true)) {
      if (k in before) secrets[k] = before[k];
    } else if (typeof v === "string") {
      if (v) secrets[k] = v;
    } else {
      throw new PluginInputError(`setting ${k} of ${inst.id} is a secret, so it takes text, null to clear it, or {"set": true} to keep it`);
    }
  }
  return { def: { ...inst, settings }, secrets };
}

/** Replace one plugin's stored instances in a repo, keeping secret settings encrypted apart. */
export async function putInstances(d: Db, project: string, repo: string, plugin: string, instances: unknown, handle: string,
                                   f: Fetch = fetch): Promise<void> {
  if (!Array.isArray(instances)) throw new PluginInputError("instances must be a list");
  const { file, errors } = checkFile({ instances: { [plugin]: instances } }, { extraPlugins: [plugin] });
  if (errors.length) throw new PluginInputError(errors.join("; "));
  const info = merge(await loadDefs(d, repo, f), {}).plugins.find((p) => p.name === plugin);
  if (!info) throw new PluginInputError(`no plugin named ${plugin} runs in ${repo}`);
  const keys = secretKeysOf(info.settings);
  const before = keys.length ? await storedInstances(d, project, repo, { secrets: true }) : {};
  const list = (file.instances?.[plugin] ?? []).map((inst) => {
    const prev = before[plugin]?.find((x) => x.id === inst.id)?.settings ?? {};
    const kept = Object.fromEntries(keys.filter((k) => typeof prev[k] === "string").map((k) => [k, prev[k] as string]));
    return splitSecrets(inst, keys, kept);
  });
  const key = secretKey();
  if (list.some((x) => Object.keys(x.secrets).length) && !key) throw new NoSecretKey();
  await d.tx(async (t) => {
    await t.query("delete from plugin_instances where project = $1 and repo = $2 and plugin = $3", [project, repo, plugin]);
    for (const [i, { def, secrets }] of list.entries()) {
      const names = Object.keys(secrets);
      await t.query(
        `insert into plugin_instances (project, repo, plugin, id, def, position, updated_by, secret_keys, secrets_enc)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`,
        [project, repo, plugin, def.id, JSON.stringify(def), i, handle, names,
         names.length ? encryptSecret(JSON.stringify(secrets), settingsScope(project, repo, plugin, def.id), key!) : null]);
    }
  });
}

/** Set the capabilities granted to one plugin in a repo, recording who granted them. */
export async function putGrants(d: Pick<Db, "query">, project: string, repo: string, plugin: string, grants: unknown, handle: string): Promise<void> {
  if (!Array.isArray(grants) || !grants.every((g) => typeof g === "string")) throw new PluginInputError("grants must be a list of capability names");
  const unknown = grants.filter((g) => !CAPABILITIES.includes(g));
  if (unknown.length) throw new PluginInputError(`unknown capability: ${unknown.join(", ")}`);
  if (!grants.length) {
    await d.query("delete from plugin_grants where project = $1 and repo = $2 and plugin = $3", [project, repo, plugin]);
    return;
  }
  await d.query(
    `insert into plugin_grants (project, repo, plugin, capabilities, granted_by, granted_at) values ($1, $2, $3, $4, $5, now())
     on conflict (project, repo, plugin) do update set capabilities = excluded.capabilities, granted_by = excluded.granted_by,
       granted_at = excluded.granted_at`, [project, repo, plugin, [...new Set(grants)], handle]);
}

// ── connections and credentials ───────────────────────────────────────────────
const envName = (connection: string) => connection.toUpperCase().replace(/[^A-Z0-9]/g, "_");

/** Connections this server offers every repo: github, and those in TODO_PLUGIN_CONNECTIONS. */
export function hostConnections(): Record<string, ConnectionDef> {
  const out: Record<string, ConnectionDef> = {
    github: { http: { url: githubApi(), ...(process.env.GITHUB_TOKEN ? { auth: "bearer" as const } : {}) } },
  };
  const raw = process.env.TODO_PLUGIN_CONNECTIONS;
  if (!raw) return out;
  try {
    const { file, errors } = checkFile({ connections: JSON.parse(raw) });
    for (const e of errors) console.error(`plugins: TODO_PLUGIN_CONNECTIONS: ${e}`);
    return { ...out, ...file.connections };
  } catch (e) {
    console.error(`plugins: TODO_PLUGIN_CONNECTIONS isn't JSON: ${message(e)}`);
    return out;
  }
}

/** Secrets for the host's connections: GITHUB_TOKEN, and TODO_PLUGIN_SECRET_<NAME>. Only shipped plugins get them. */
export function hostSecrets(connections = hostConnections()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(connections)) {
    const v = name === "github" ? process.env.GITHUB_TOKEN : process.env[`TODO_PLUGIN_SECRET_${envName(name)}`];
    if (v) out[name] = v;
  }
  return out;
}

/** Hosts plugins may reach even on a private address: TODO_PLUGIN_ALLOW_HOSTS, comma-separated host or host:port. */
export const allowedHosts = () => (process.env.TODO_PLUGIN_ALLOW_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);

const credentialScope = (project: string, repo: string, connection: string) => [project, repo, connection];

/** Store (or, with null, forget) a repo connection's secret. */
export async function putCredential(d: Pick<Db, "query">, project: string, repo: string, connection: unknown, secret: unknown,
                                    handle: string): Promise<void> {
  if (typeof connection !== "string" || !CONNECTION_NAME.test(connection)) throw new PluginInputError("connection must be a connection name");
  if (secret === null) {
    await d.query("delete from plugin_credentials where project = $1 and repo = $2 and connection = $3", [project, repo, connection]);
    return;
  }
  const key = secretKey();
  if (!key) throw new NoSecretKey();
  if (typeof secret !== "string" || !secret) throw new PluginInputError("secret must be a non-empty string, or null to forget it");
  await d.query(
    `insert into plugin_credentials (project, repo, connection, secret_enc, updated_by, updated_at) values ($1, $2, $3, $4, $5, now())
     on conflict (project, repo, connection) do update set secret_enc = excluded.secret_enc, updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`, [project, repo, connection, encryptSecret(secret, credentialScope(project, repo, connection), key), handle]);
}

/** The repo's stored secrets this server can read; none without TODO_SECRET_KEY. */
export async function repoSecrets(d: Pick<Db, "query">, project: string, repo: string): Promise<Record<string, string>> {
  const key = secretKey();
  if (!key) return {};
  const out: Record<string, string> = {};
  for (const r of await d.query("select connection, secret_enc from plugin_credentials where project = $1 and repo = $2", [project, repo])) {
    const plain = decryptSecret(r.secret_enc, credentialScope(project, repo, r.connection), key);
    if (plain !== null) out[r.connection] = plain;
  }
  return out;
}

/** Repo connections this server can authorize with a stored credential. */
async function repoSecretNames(d: Pick<Db, "query">, project: string, repo: string): Promise<string[]> {
  if (!secretKey()) return [];
  return (await d.query("select connection from plugin_credentials where project = $1 and repo = $2 order by connection", [project, repo]))
    .map((r) => r.connection as string);
}

// ── repos a project may use ───────────────────────────────────────────────────
export interface ProjectRepos { repos: { repo: string; added_by: string; added_at: string }[]; checkouts: string[] }

export async function projectRepos(d: Pick<Db, "query">, project: string): Promise<ProjectRepos> {
  const repos = await d.query("select repo, added_by, added_at from plugin_repos where project = $1 order by repo", [project]);
  const checkouts = await d.query("select distinct repo from checkouts where project = $1 and repo <> '' order by repo", [project]);
  return { repos: repos.map((r) => ({ repo: r.repo, added_by: r.added_by, added_at: new Date(r.added_at).toISOString() })),
           checkouts: checkouts.map((r) => r.repo) };
}

/** Replace the repos listed for a project; each must be a GitHub owner/name. */
export async function putProjectRepos(d: Db, project: string, raw: unknown, handle: string): Promise<string[]> {
  if (!Array.isArray(raw) || !raw.every((r) => typeof r === "string")) throw new PluginInputError("repos must be a list of owner/name");
  const repos = [...new Set(raw.map((r) => r.trim()).filter(Boolean))];
  const bad = repos.filter((r) => !repoKey(r));
  if (bad.length) throw new PluginInputError(`not a GitHub owner/name: ${bad.join(", ")}`);
  const keys = [...new Set(repos.map((r) => repoKey(r)))].sort();
  await d.tx(async (t) => {
    await t.query("delete from plugin_repos where project = $1 and not (repo = any($2))", [project, keys]);
    for (const repo of keys) {
      await t.query("insert into plugin_repos (project, repo, added_by) values ($1, $2, $3) on conflict do nothing", [project, repo, handle]);
    }
  });
  return keys;
}

// ── what the CLI and dashboard read ───────────────────────────────────────────
export interface LastRun { at: string; item: string; skipped?: string; error?: string }

async function lastRuns(d: Pick<Db, "query">, project: string, repo: string): Promise<Record<string, LastRun>> {
  const rows = await d.query(
    `select distinct on (plugin, instance) plugin, instance, at, result, item_uid from plugin_runs
      where project = $1 and repo = $2 order by plugin, instance, id desc`, [project, repo]);
  const out: Record<string, LastRun> = {};
  for (const r of rows) {
    const res = r.result as RunResult;
    out[`${r.plugin}/${r.instance}`] = { at: new Date(r.at).toISOString(), item: r.item_uid,
      ...(res.skipped ? { skipped: res.skipped } : {}), ...(res.error ? { error: res.error } : {}) };
  }
  return out;
}

/** Whether this server runs a plugin for the repo: every connection it needs resolves here, with the secret for
 * its origin, starts no command, and isn't on a private address the allow list doesn't name. */
async function serverRuns(p: PluginInfo, file: PluginsFile, repoCreds: string[], guard: AddressGuard): Promise<boolean> {
  if (!pluginsEnabled()) return false;
  const host = hostConnections();
  const hostKeys = hostSecrets(host);
  for (const name of p.connections) {
    const own = file.connections?.[name];
    const def = own ?? host[name];
    if (!def) return false;
    let url: string;
    if ("mcp" in def) {
      if (!("url" in def.mcp)) return false;
      url = def.mcp.url;
    } else {
      url = def.http.url;
      if (def.http.auth && (own ? !repoCreds.includes(name) : !p.shipped || !hostKeys[name])) return false;
    }
    if (!(await addressAllowed(url, guard))) return false;
  }
  return true;
}

export interface RepoPlugins {
  instances: Record<string, InstanceDef[]>;
  grants: Record<string, string[]>;
  /** Each instance says whether this server runs it; a CLI runs only the ones it doesn't. */
  plugins: (Omit<PluginInfo, "instances"> & { instances: (InstanceDef & { server_runs: boolean })[] })[];
  /** Repo connections this server holds a credential for. */
  secrets: string[];
  /** Host connections with a secret, which only shipped plugins receive. */
  host_secrets: string[];
  runs: Record<string, LastRun>;
  errors: string[];
}

/** One repo's plugins as a project sees them, secrets masked. A repo file GitHub won't give leaves the shipped plugins and an error. */
export async function repoPlugins(d: Pick<Db, "query">, project: string, repo: string, f: Fetch = fetch,
                                  lookup?: AddressGuard["lookup"]): Promise<RepoPlugins> {
  const instances = await storedInstances(d, project, repo);
  const errors: string[] = [];
  let defs: RepoDefs = { files: {}, sha: null, defaultBranch: null };
  try {
    defs = await loadDefs(d, repo, f);
  } catch (e) {
    errors.push(`couldn't read ${repo}'s ${PLUGINS_DIR}: ${message(e)}`);
  }
  const merged = merge(defs, instances);
  const creds = await repoSecretNames(d, project, repo);
  const guard: AddressGuard = { allow: allowedHosts(), ...(lookup ? { lookup } : {}) };
  const plugins = [];
  for (const p of merged.plugins) {
    const runs = await serverRuns(p, merged.file, creds, guard);
    plugins.push({ ...p, instances: p.instances.map((i) => ({ ...masked(i, secretKeysOf(p.settings)), server_runs: runs })) });
  }
  return {
    instances, grants: await storedGrants(d, project, repo), plugins, secrets: creds,
    host_secrets: Object.keys(hostSecrets()).sort(), runs: await lastRuns(d, project, repo), errors: [...errors, ...merged.errors],
  };
}
