// What the server keeps for plugins, per project and repo: each repo's plugin
// config (deploy branches, shipped plugins switched on, connections, custom
// plugins), the instances and grants people set, connection credentials and
// secret settings (encrypted), each project's own connections for the plugins
// that ship with todo, and which repos a project may use at all.
import type { Db, Row } from "../db";
import { repoKey } from "../checkouts";
import { githubApi } from "../github";
import { GITHUB, githubToken, type GithubSource } from "../github-token";
import { branchList, checkCustom, composeConfig, INHERITED, NAME, type ConfigParts, type CustomCheck, type CustomPlugin } from "./config";
import { addressAllowed, hostPort, privateAddress, type AddressGuard } from "./connections";
import { allInstances, bindConnections, connectionsFor, pluginsFor, wouldSkip, type Resolved } from "./host";
import { checkFile, parsePlugins } from "./load";
import { decryptSecret, encryptSecret, NoSecretKey, projectSecretScope, secretKey } from "./secrets";
import { ALWAYS_ON, isShipped, SHIPPED } from "./shipped";
import {
  POST_REQUEST, type ConnectionDef, type InstanceDef, type PluginConfig, type PluginDef, type PluginsFile, type ResolvedConnection,
  type RunResult, type Trigger,
} from "./types";

const CAPABILITIES = [POST_REQUEST];
/** What GET shows for a secret setting that has a value. */
export const SECRET_SET = { set: true } as const;

const isMap = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class PluginInputError extends Error {
  constructor(msg: string, readonly errors: string[] = [msg]) {
    super(msg);
  }
}

/** The change was made against something that has changed since; the API answers 409. */
export class PluginConflict extends Error {}
const UNIQUE_VIOLATION = "23505";

/** Where a connection calls: its http or MCP URL, or an MCP command line. A credential is given for this. */
export function endpointOf(def: unknown): string | null {
  if (!isMap(def)) return null;
  for (const kind of ["http", "mcp"]) {
    const c = def[kind];
    if (isMap(c) && typeof c.url === "string") return c.url;
    if (isMap(c) && typeof c.command === "string") return [c.command, ...(Array.isArray(c.args) ? c.args : [])].join(" ");
  }
  return null;
}

// ── the config ────────────────────────────────────────────────────────────────
export interface StoredCustom extends CustomPlugin { version: number; updated_by: string; updated_at: string }

export interface StoredConfig extends ConfigParts {
  custom: StoredCustom[];
  /** Who last changed the config's own row, and when; null for a repo nobody has set up. */
  updated: { by: string; at: string } | null;
}

const iso = (v: unknown) => new Date(v as string).toISOString();

/** The repo's plugin config in the project; an empty one when nobody has set it up. `repo` must be a repoKey. */
export async function loadConfig(d: Pick<Db, "query">, project: string, repo: string): Promise<StoredConfig> {
  const [row] = await d.query("select track, shipped, connections, updated_by, updated_at from plugin_configs where project = $1 and repo = $2",
                              [project, repo]);
  const custom = await d.query("select name, manifest, code, version, updated_by, updated_at from plugin_custom where project = $1 and repo = $2 order by name",
                               [project, repo]);
  return {
    track: row?.track ?? [], shipped: (row?.shipped ?? []).filter((n: string) => isShipped(n)),
    connections: isMap(row?.connections) ? row.connections : {},
    custom: custom.map((c) => ({ name: c.name, manifest: c.manifest, code: c.code ?? null, version: Number(c.version), updated_by: c.updated_by,
                                 updated_at: iso(c.updated_at) })),
    updated: row ? { by: row.updated_by, at: iso(row.updated_at) } : null,
  };
}

async function updateConfig(d: Pick<Db, "query">, project: string, repo: string, handle: string, set: string, args: unknown[]): Promise<void> {
  await d.query(`insert into plugin_configs (project, repo, updated_by) values ($1, $2, $3) on conflict (project, repo) do nothing`,
                [project, repo, handle]);
  await d.query(`update plugin_configs set ${set}, updated_by = $3, updated_at = now() where project = $1 and repo = $2`,
                [project, repo, handle, ...args]);
}

/** Replace the repo's deploy branches. With `base`, the list the change was made on, it's refused unless the list still is that,
 * so a page loaded before someone else's change can't drop their branch. */
export async function putTrack(d: Db, project: string, repo: string, raw: unknown, handle: string, base?: unknown): Promise<string[]> {
  let track: string[];
  let was: string[] | undefined;
  try {
    track = branchList(raw);
    was = base === undefined ? undefined : branchList(base);
  } catch (e) {
    throw new PluginInputError(message(e));
  }
  await d.tx(async (t) => {
    await t.query("insert into plugin_configs (project, repo, updated_by) values ($1, $2, $3) on conflict (project, repo) do nothing", [project, repo, handle]);
    const [row] = await t.query("select track from plugin_configs where project = $1 and repo = $2 for update", [project, repo]);
    if (was && JSON.stringify(row.track ?? []) !== JSON.stringify(was)) {
      const now = (row.track ?? []).join(", ") || "none";
      throw new PluginConflict(`the deploy branches changed since this page loaded: they're ${now} now; reload and change them again`);
    }
    await updateConfig(t, project, repo, handle, "track = $4", [track]);
  });
  return track;
}

/** Switch a shipped plugin on or off for the repo; its stored instances stay either way. */
export async function setShipped(d: Pick<Db, "query">, project: string, repo: string, name: unknown, on: boolean, handle: string): Promise<void> {
  if (typeof name !== "string" || !isShipped(name)) throw new PluginInputError(`no plugin named ${String(name)} ships with todo`);
  if (ALWAYS_ON.includes(name)) throw new PluginInputError(`${name} is on for every repo; switch its instance off in its settings instead`);
  await updateConfig(d, project, repo, handle,
    on ? "shipped = case when $4 = any(shipped) then shipped else array_append(shipped, $4) end" : "shipped = array_remove(shipped, $4)", [name]);
}

/** JSON with every map's keys sorted, so two spellings of one definition compare equal. */
const canonical = (v: unknown): string => JSON.stringify(v, (_, x) =>
  (isMap(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

/** Holds a project's connection name for the rest of the transaction, so a repo connection and one of the project's own can't
 * take the same name at once. */
const lockName = (t: Pick<Db, "query">, project: string, name: string) =>
  t.query("select pg_advisory_xact_lock(hashtext($1))", [`connection\x1f${project}\x1f${name}`]);

/** Declare (or, with null, drop) one of the repo's connections. Dropping or changing one forgets its credential, which was given
 * for the endpoint it named. With `base`, where the person saw it point (null for a new one), it's refused once it points
 * elsewhere. A repo can't take the name of one of this server's or this project's own connections, which the shipped plugins
 * use. The server never starts a command, and a CLI never does for a connection the server's config declares, so only http and
 * MCP URLs are taken. */
export async function putConnection(d: Db, project: string, repo: string, name: unknown, def: unknown, handle: string,
                                    base?: unknown): Promise<void> {
  if (typeof name !== "string" || !NAME.test(name) || INHERITED.includes(name)) {
    throw new PluginInputError("a connection's name starts with a letter and has only letters, digits, - and _");
  }
  if (base !== undefined && base !== null && typeof base !== "string") throw new PluginInputError("base is where the connection pointed, or null for a new one");
  const forget = (t: Pick<Db, "query">) =>
    t.query("delete from plugin_credentials where project = $1 and repo = $2 and connection = $3", [project, repo, name]);
  /** The connection as it stands, locked; refused when it isn't where the change was made. */
  const current = async (t: Pick<Db, "query">) => {
    await t.query("insert into plugin_configs (project, repo, updated_by) values ($1, $2, $3) on conflict (project, repo) do nothing", [project, repo, handle]);
    const [row] = await t.query("select connections -> $3::text as def from plugin_configs where project = $1 and repo = $2 for update",
                                [project, repo, name]);
    const now = row?.def ? endpointOf(row.def) : null;
    if (base !== undefined && now !== base) {
      throw new PluginConflict(now === null ? `${name} was removed meanwhile; reload to see the connections as they are`
        : `${name} points at ${now} now; reload to see it`);
    }
    return row?.def ?? null;
  };
  if (def === null) {
    await d.tx(async (t) => {
      await current(t);
      await updateConfig(t, project, repo, handle, "connections = connections - $4::text", [name]);
      await forget(t);
    });
    return;
  }
  if (name in hostConnections()) {
    throw new PluginInputError(`connection ${name}: this server has its own ${name}, which plugins that ship with todo use; give the repo's another name`);
  }
  const { file, errors } = checkFile({ connections: { [name]: def } });
  if (errors.length) throw new PluginInputError(errors.join("; "), errors);
  const conn = file.connections![name];
  if ("mcp" in conn && "command" in conn.mcp) throw new PluginInputError(`connection ${name}: give an MCP server's URL; the server never starts a command`);
  await d.tx(async (t) => {
    await lockName(t, project, name);
    const [own] = await t.query("select 1 from project_connections where project = $1 and name = $2", [project, name]);
    if (own) {
      throw new PluginInputError(`connection ${name}: this project has its own ${name}, which plugins that ship with todo use; give the repo's another name`);
    }
    const was = await current(t);
    // A credential left from before the connection was declared, or given for another definition, isn't this one's.
    if (!was || canonical(was) !== canonical(conn)) await forget(t);
    await updateConfig(t, project, repo, handle, "connections = connections || jsonb_build_object($4::text, $5::jsonb)", [name, JSON.stringify(conn)]);
  });
}

/** Check a custom plugin against the repo's config as it is now; `was` is the name it's saved under, when it has one. */
export async function checkStoredCustom(d: Pick<Db, "query">, project: string, repo: string, p: CustomPlugin, was?: string | null): Promise<CustomCheck> {
  const config = await loadConfig(d, project, repo);
  const reserved = [...Object.keys(SHIPPED), ...config.custom.map((c) => c.name).filter((n) => n !== was)];
  return checkCustom(p, { reserved, connections: Object.keys(config.connections) });
}

/** Give a plugin's instances to another name, their secret settings encrypted again for it, since the plugin's name is part of
 * what they're encrypted under. Without the key they move as they are, as unreadable as they were. */
async function moveInstances(t: Pick<Db, "query">, project: string, repo: string, from: string, to: string): Promise<void> {
  const key = secretKey();
  const rows = await t.query("select id, secrets_enc from plugin_instances where project = $1 and repo = $2 and plugin = $3", [project, repo, from]);
  for (const r of rows) {
    const plain = key && r.secrets_enc ? decryptSecret(r.secrets_enc, settingsScope(project, repo, from, r.id), key) : null;
    const secrets = plain === null ? r.secrets_enc : encryptSecret(plain, settingsScope(project, repo, to, r.id), key!);
    await t.query("update plugin_instances set plugin = $4, secrets_enc = $5 where project = $1 and repo = $2 and plugin = $3 and id = $6",
                  [project, repo, from, to, secrets, r.id]);
  }
}

/** Add or replace a custom plugin, renaming it from `was`, whose instances and grants follow it. An edit gives `base`, the version
 * it began from, and is refused when the plugin has been saved since. Refused, every problem listed, unless it checks clean
 * against the repo's plugins as they are when it's written. */
export async function putCustom(d: Db, project: string, repo: string, raw: unknown, handle: string): Promise<CustomCheck> {
  if (!isMap(raw) || typeof raw.name !== "string" || typeof raw.manifest !== "string"
      || !(raw.code === undefined || raw.code === null || typeof raw.code === "string") || !(raw.was === undefined || raw.was === null || typeof raw.was === "string")) {
    throw new PluginInputError("give {name, manifest, code?, was?, base?}, each text but base");
  }
  const p: CustomPlugin = { name: raw.name.trim(), manifest: raw.manifest, code: raw.code?.trim() ? raw.code : null };
  const was = raw.was ?? null;
  if (was && typeof raw.base !== "number") throw new PluginInputError(`give base: the version of ${was} the edit began from`);
  try {
    return await d.tx(async (t) => {
      let version = 1;
      if (was) {
        const [cur] = await t.query("select version, updated_by from plugin_custom where project = $1 and repo = $2 and name = $3 for update",
                                    [project, repo, was]);
        if (!cur) throw new PluginConflict(`${was} was removed meanwhile; reload to see the plugins as they are`);
        if (Number(cur.version) !== raw.base) throw new PluginConflict(`${was} was changed by ${cur.updated_by} since this page loaded; reload to see it`);
        version = Number(cur.version) + 1;
      }
      const check = await checkStoredCustom(t, project, repo, p, was);
      if (check.errors.length) throw new PluginInputError(check.errors.join("; "), check.errors);
      if (was === p.name) {
        await t.query("update plugin_custom set manifest = $4, code = $5, version = $6, updated_by = $7, updated_at = now() where project = $1 and repo = $2 and name = $3",
                      [project, repo, p.name, p.manifest, p.code, version, handle]);
        return check;
      }
      // A name new to the repo starts clean: nothing stored under it from before belongs to this plugin.
      for (const table of ["plugin_instances", "plugin_grants"]) {
        await t.query(`delete from ${table} where project = $1 and repo = $2 and plugin = $3`, [project, repo, p.name]);
      }
      if (was) {
        await t.query("delete from plugin_custom where project = $1 and repo = $2 and name = $3", [project, repo, was]);
        await moveInstances(t, project, repo, was, p.name);
        await t.query("update plugin_grants set plugin = $4 where project = $1 and repo = $2 and plugin = $3", [project, repo, was, p.name]);
      }
      await t.query("insert into plugin_custom (project, repo, name, manifest, code, version, updated_by) values ($1, $2, $3, $4, $5, $6, $7)",
                    [project, repo, p.name, p.manifest, p.code, version, handle]);
      return check;
    });
  } catch (e) {
    if ((e as { code?: string }).code === UNIQUE_VIOLATION) throw new PluginConflict(`a plugin named ${p.name} was saved meanwhile; reload to see it`);
    throw e;
  }
}

/** Drop instances and grants stored for a plugin that neither ships with todo nor is one of the repo's custom plugins: left from
 * a plugin a repo's own file once defined, they belong to nothing, and a custom plugin of that name starts clean. */
export async function pruneLeftovers(d: Pick<Db, "query">): Promise<void> {
  for (const table of ["plugin_instances", "plugin_grants"]) {
    await d.query(
      `delete from ${table} i where not (i.plugin = any($1))
          and not exists (select 1 from plugin_custom c where c.project = i.project and c.repo = i.repo and c.name = i.plugin)`,
      [Object.keys(SHIPPED)]);
  }
}

/** Remove a custom plugin with its instances and grants. */
export async function removeCustom(d: Db, project: string, repo: string, name: unknown): Promise<void> {
  if (typeof name !== "string") throw new PluginInputError("name the custom plugin to remove");
  await d.tx(async (t) => {
    const [gone] = await t.query("delete from plugin_custom where project = $1 and repo = $2 and name = $3 returning name", [project, repo, name]);
    if (!gone) throw new PluginInputError(`no custom plugin named ${name} in ${repo}`);
    for (const table of ["plugin_instances", "plugin_grants"]) {
      await t.query(`delete from ${table} where project = $1 and repo = $2 and plugin = $3`, [project, repo, name]);
    }
  });
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

export interface Merged { file: PluginsFile; config: PluginConfig; resolved: Resolved[]; plugins: PluginInfo[]; errors: string[] }

/** The plugins a repo runs: the always-on shipped ones and its config's, with every stored instance, switched off or not. */
export function merge(stored: ConfigParts, instances: Record<string, InstanceDef[]>): Merged {
  const { config, errors } = composeConfig(stored);
  const loaded = parsePlugins(config.text, { extraPlugins: ALWAYS_ON });
  errors.push(...loaded.errors);
  const resolved = pluginsFor({ config }, loaded.file, errors);
  const plugins = resolved.map(({ name, def, shipped }) => ({
    name, connections: def.connections ?? [], on: def.on ?? [], every: def.every ?? null, settings: def.settings ?? {},
    instances: allInstances(def, instances[name] ?? []), shipped,
  }));
  return { file: loaded.file, config, resolved, plugins, errors };
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
export async function putInstances(d: Db, project: string, repo: string, plugin: string, instances: unknown, handle: string): Promise<void> {
  if (!Array.isArray(instances)) throw new PluginInputError("instances must be a list");
  const { file, errors } = checkFile({ instances: { [plugin]: instances } }, { extraPlugins: [plugin] });
  if (errors.length) throw new PluginInputError(errors.join("; "));
  const info = merge(await loadConfig(d, project, repo), {}).plugins.find((p) => p.name === plugin);
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
    // A rename or removal between the check above and this write would strand what it stores under the old name.
    if (!isShipped(plugin)) {
      const [still] = await t.query("select 1 from plugin_custom where project = $1 and repo = $2 and name = $3 for update", [project, repo, plugin]);
      if (!still) throw new PluginConflict(`${plugin} was renamed or removed meanwhile; reload to see the plugins as they are`);
    }
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

/** Connections this server offers every project by default: github, and those in TODO_PLUGIN_CONNECTIONS. A project's own of a
 * name stand in for them. Only shipped plugins use them, except that a custom plugin gets github without its token. */
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

/** Secrets for the server's own connections: GITHUB_TOKEN, and TODO_PLUGIN_SECRET_<NAME>. Only shipped plugins get them. */
export function hostSecrets(connections = hostConnections()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(connections)) {
    const v = name === "github" ? process.env.GITHUB_TOKEN : process.env[`TODO_PLUGIN_SECRET_${envName(name)}`];
    if (v) out[name] = v;
  }
  return out;
}

const allowEntries = () => (process.env.TODO_PLUGIN_ALLOW_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);

/** The address guard for one repo's runs, from TODO_PLUGIN_ALLOW_HOSTS: a `host[:port]` entry opens a private host to
 * the host's own connections, which shipped plugins use; `owner/name=host[:port]` opens it to that repo's connections.
 * `named`: the project's own connections whose private address someone allowed on Settings → Automation, each for itself. */
export function guardFor(repo: string, lookup?: AddressGuard["lookup"], named: Record<string, string> = {}): AddressGuard {
  const entries = allowEntries();
  const allow = entries.filter((e) => !e.includes("="));
  const repoAllow = entries.filter((e) => e.includes("=")).map((e) => e.split("=", 2))
    .filter(([r]) => repoKey(r.trim()) === repo).map(([, h]) => h.trim()).filter(Boolean);
  return { allow, repoAllow, named, ...(lookup ? { lookup } : {}) };
}

// ── a project's own connections ───────────────────────────────────────────────
/** One of a project's own connections, as the page shows it: never its secret. */
export interface ProjectConnection {
  name: string;
  def: ConnectionDef;
  /** A secret is stored for where it points now, and this server can read it. */
  held: boolean;
  /** A secret is stored for where it points now that this server can't read: no TODO_SECRET_KEY, or another one. */
  unreadable: boolean;
  /** Who let todo call its private address, and when. */
  privateOk: { by: string; at: string } | null;
  /** Counts its saves; a change sends the one it was made on. */
  version: number;
  updated: { by: string; at: string };
}

/** The address is on a private network and nobody has let todo call it there; the API answers 400 with `private: true`. */
export class PrivateAddress extends PluginInputError {}

/** github's address is always this server's GitHub API: a project gives only its token. */
const githubDef = (): ConnectionDef => ({ http: { url: githubApi(), auth: "bearer" } });

interface StoredRow { name: string; def: ConnectionDef; secret_enc: string | null; secret_endpoint: string | null; private_ok: Row | null;
                      version: number; updated_by: string; updated_at: string }

/** A stored row read as it stands: its definition, the secret it may hand out, and whether its private address is allowed. */
function readRow(project: string, r: StoredRow, key: Buffer | null) {
  const def = r.name === GITHUB ? githubDef() : r.def;
  const endpoint = endpointOf(def) ?? "";
  const bound = !!r.secret_enc && r.secret_endpoint === endpoint;
  const secret = bound && key ? decryptSecret(r.secret_enc!, projectSecretScope(project, r.name, endpoint), key) : null;
  const privateOk = isMap(r.private_ok) && r.private_ok.endpoint === endpoint ? { by: String(r.private_ok.by), at: iso(r.private_ok.at) } : null;
  return { def, endpoint, secret, bound, privateOk };
}

async function storedRows(d: Pick<Db, "query">, project: string): Promise<StoredRow[]> {
  return d.query("select name, def, secret_enc, secret_endpoint, private_ok, version, updated_by, updated_at from project_connections where project = $1 order by name",
                 [project]) as Promise<StoredRow[]>;
}

/** The project's own connections, secrets masked. */
export async function projectConnections(d: Pick<Db, "query">, project: string): Promise<ProjectConnection[]> {
  const key = secretKey();
  return (await storedRows(d, project)).map((r) => {
    const { def, secret, bound, privateOk } = readRow(project, r, key);
    return { name: r.name, def, held: secret !== null, unreadable: bound && secret === null, privateOk, version: Number(r.version),
             updated: { by: r.updated_by, at: iso(r.updated_at) } };
  });
}

/** Whether saving a host connection at `url` needs someone to allow its private address: not when TODO_PLUGIN_ALLOW_HOSTS opens it
 * to every project, nor when it doesn't resolve here, so that can't be told. */
async function needsPrivateOk(url: string | null, lookup?: AddressGuard["lookup"]): Promise<boolean> {
  if (!url) return false;
  return (await privateAddress(url, { allow: allowEntries().filter((e) => !e.includes("=")), ...(lookup ? { lookup } : {}) })) === true;
}

/** Add, change or (def null) remove one of a project's own connections: `{name, def?, secret?, base, allowPrivate?}`. `base` is the
 * version the change was made on, null for a new one; it's refused once the connection has been saved since. Changing where it
 * points, or how it authorizes, drops its secret and any private-address allowance unless the same change gives them again.
 * Pointing it at a private address needs `allowPrivate: true`, which records who allowed it and when. A secret needs
 * TODO_SECRET_KEY. github takes only a secret: its address is this server's GitHub API. */
export async function putProjectConnection(d: Db, project: string, raw: unknown, handle: string,
                                           opts: { lookup?: AddressGuard["lookup"] } = {}): Promise<void> {
  if (!isMap(raw)) throw new PluginInputError("give {name, def?, secret?, base, allowPrivate?}");
  const { name, secret, base, allowPrivate } = raw;
  if (typeof name !== "string" || !NAME.test(name) || INHERITED.includes(name)) {
    throw new PluginInputError("a connection's name starts with a letter and has only letters, digits, - and _");
  }
  if (base !== null && !(typeof base === "number" && Number.isInteger(base))) {
    throw new PluginInputError("give base: the version of the connection the page showed, or null for a new one");
  }
  if (!(secret === undefined || secret === null || (typeof secret === "string" && secret))) {
    throw new PluginInputError("secret must be a non-empty string, or null to forget it");
  }
  if (!(allowPrivate === undefined || typeof allowPrivate === "boolean")) throw new PluginInputError("allowPrivate is true or false");
  let def: ConnectionDef | null | undefined;
  if (raw.def === null || raw.def === undefined) def = raw.def;
  else if (name === GITHUB) {
    if (canonical(raw.def) !== canonical(githubDef())) throw new PluginInputError(`github's address is this server's GitHub API, ${githubApi()}; give only its token`);
    def = githubDef();
  } else {
    const { file, errors } = checkFile({ connections: { [name]: raw.def } });
    if (errors.length) throw new PluginInputError(errors.join("; "), errors);
    def = file.connections![name];
    if ("mcp" in def && "command" in def.mcp) throw new PluginInputError(`connection ${name}: give an MCP server's URL; the server never starts a command`);
  }
  const key = secretKey();
  if (typeof secret === "string" && !key) throw new NoSecretKey();
  const checkPrivate = def !== undefined && def !== null ? needsPrivateOk(endpointOf(def), opts.lookup) : null;
  try {
    await d.tx(async (t) => {
      await lockName(t, project, name);
      const [row] = await t.query("select * from project_connections where project = $1 and name = $2 for update", [project, name]) as StoredRow[];
      const version = row ? Number(row.version) : null;
      if (version !== base) {
        throw new PluginConflict(!row ? `${name} was removed meanwhile; reload to see the connections as they are`
          : base === null ? `a connection named ${name} was added meanwhile; reload to see it`
          : `${name} was changed by ${row.updated_by} since this page loaded; reload to see it`);
      }
      if (def === null || (name === GITHUB && secret === null)) {
        await t.query("delete from project_connections where project = $1 and name = $2", [project, name]);
        return;
      }
      if (!row) {
        const [taken] = await t.query("select repo from plugin_configs where project = $1 and connections ? $2 order by repo limit 1", [project, name]);
        if (taken) throw new PluginInputError(`${taken.repo} has a connection named ${name} for its custom plugins; give this one another name`);
      }
      const was = row ? readRow(project, row, key) : null;
      const next = def ?? was?.def ?? (name === GITHUB ? githubDef() : undefined);
      if (!next) throw new PluginInputError(`give def: where ${name} points`);
      const endpoint = endpointOf(next)!;
      const same = !!was && canonical(was.def) === canonical(next);
      const moved = !was || was.endpoint !== endpoint;
      let secretEnc: string | null = same && was!.bound ? row!.secret_enc : null;
      if (typeof secret === "string") secretEnc = encryptSecret(secret, projectSecretScope(project, name, endpoint), key!);
      else if (secret === null) secretEnc = null;
      if (name === GITHUB && !secretEnc) throw new PluginInputError("give github's token");
      const kept = !moved && was?.privateOk ? row!.private_ok : null;
      const privateOk = allowPrivate === true ? { by: handle, at: new Date().toISOString(), endpoint } : allowPrivate === false ? null : kept;
      if (checkPrivate && (await checkPrivate) && !privateOk) {
        throw new PrivateAddress(`${endpoint} is on a private network: allow todo to call it there, or give another address`);
      }
      await t.query(
        `insert into project_connections (project, name, def, secret_enc, secret_endpoint, private_ok, version, updated_by, updated_at)
         values ($1, $2, $3::jsonb, $4, $5, $6::jsonb, $7, $8, now())
         on conflict (project, name) do update set def = excluded.def, secret_enc = excluded.secret_enc, secret_endpoint = excluded.secret_endpoint,
           private_ok = excluded.private_ok, version = excluded.version, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        [project, name, JSON.stringify(next), secretEnc, secretEnc ? endpoint : null, privateOk ? JSON.stringify(privateOk) : null,
         (version ?? 0) + 1, handle]);
    });
  } catch (e) {
    if ((e as { code?: string }).code === UNIQUE_VIOLATION) throw new PluginConflict(`a connection named ${name} was added meanwhile; reload to see it`);
    throw e;
  }
}

/** The connections a project's shipped plugins get in one of its repos: the server's, each one the project set for itself in
 * place of the server's of that name, and github with the token that reads the repo. */
export interface HostSet {
  connections: Record<string, ConnectionDef>;
  secrets: Record<string, string>;
  /** The names the project set for itself; the rest are the server's. */
  page: string[];
  /** The project's connections whose private address someone allowed, with the host:port allowed. */
  privateOk: Record<string, string>;
  /** The project's connections whose stored secret this server can't read. */
  unreadable: string[];
  /** Whose token reads the repo on GitHub; null when todo has none for it. */
  github: GithubSource | null;
}

export async function hostSet(d: Pick<Db, "query">, project: string, repo: string): Promise<HostSet> {
  const connections = hostConnections();
  const secrets = hostSecrets(connections);
  const page: string[] = [];
  const privateOk: Record<string, string> = {};
  const unreadable: string[] = [];
  const key = secretKey();
  for (const r of await storedRows(d, project)) {
    if (r.name === GITHUB) continue;
    const { def, endpoint, secret, bound, privateOk: ok } = readRow(project, r, key);
    connections[r.name] = def;
    page.push(r.name);
    delete secrets[r.name];
    if (secret !== null) secrets[r.name] = secret;
    else if (bound) unreadable.push(r.name);
    if (ok) privateOk[r.name] = hostPort(new URL(endpoint));
  }
  const gh = await githubToken(d, project, repo);
  connections[GITHUB] = { http: { url: githubApi(), ...(gh ? { auth: "bearer" as const } : {}) } };
  delete secrets[GITHUB];
  if (gh) secrets[GITHUB] = gh.token;
  if (gh?.source === "page") page.push(GITHUB);
  return { connections, secrets, page: page.sort(), privateOk, unreadable, github: gh?.source ?? null };
}

const credentialScope = (project: string, repo: string, connection: string) => [project, repo, connection];

/** Store (or, with null, forget) the secret for a connection the repo's config declares, given for `endpoint`, where the person
 * saw it point. Checked against the config in the same transaction that writes it, so a repoint can't slip between. */
export async function putCredential(d: Db, project: string, repo: string, connection: unknown, secret: unknown, handle: string,
                                    endpoint?: unknown): Promise<void> {
  if (typeof connection !== "string" || !NAME.test(connection) || INHERITED.includes(connection)) {
    throw new PluginInputError("connection must be a connection name");
  }
  if (secret === null) {
    await d.query("delete from plugin_credentials where project = $1 and repo = $2 and connection = $3", [project, repo, connection]);
    return;
  }
  await d.tx(async (t) => {
    const [row] = await t.query("select connections -> $3::text as def from plugin_configs where project = $1 and repo = $2 for update",
                                [project, repo, connection]);
    if (!row?.def) throw new PluginInputError(`${repo}'s config declares no connection ${connection}; a credential is given for a declared one`);
    if (typeof secret !== "string" || !secret) throw new PluginInputError("secret must be a non-empty string, or null to forget it");
    if (typeof endpoint !== "string" || !endpoint) throw new PluginInputError("give endpoint: where the connection pointed when its credential was entered");
    const now = endpointOf(row.def);
    if (now !== endpoint) throw new PluginConflict(`${connection} points at ${now} now, not ${endpoint}; reload and enter the credential again`);
    const key = secretKey();
    if (!key) throw new NoSecretKey();
    await t.query(
      `insert into plugin_credentials (project, repo, connection, secret_enc, endpoint, updated_by, updated_at) values ($1, $2, $3, $4, $5, $6, now())
       on conflict (project, repo, connection) do update set secret_enc = excluded.secret_enc, endpoint = excluded.endpoint,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [project, repo, connection, encryptSecret(secret, credentialScope(project, repo, connection), key), endpoint, handle]);
  });
}

/** The credentials for the repo's connections that still point where each was given: those this server can read, and the
 * names of those it can't (no TODO_SECRET_KEY, or a different one). */
async function credentials(d: Pick<Db, "query">, project: string, repo: string): Promise<{ secrets: Record<string, string>; unreadable: string[] }> {
  const key = secretKey();
  const { connections } = await loadConfig(d, project, repo);
  const secrets: Record<string, string> = {};
  const unreadable: string[] = [];
  for (const r of await d.query("select connection, secret_enc, endpoint from plugin_credentials where project = $1 and repo = $2", [project, repo])) {
    if (!Object.hasOwn(connections, r.connection) || r.endpoint !== endpointOf(connections[r.connection])) continue;
    const plain = key ? decryptSecret(r.secret_enc, credentialScope(project, repo, r.connection), key) : null;
    if (plain === null) unreadable.push(r.connection);
    else secrets[r.connection] = plain;
  }
  return { secrets, unreadable };
}

/** The secrets this server can read for the repo's connections, each only while its connection points where it was given. */
export async function repoSecrets(d: Pick<Db, "query">, project: string, repo: string): Promise<Record<string, string>> {
  return (await credentials(d, project, repo)).secrets;
}

// ── repos a project may use ───────────────────────────────────────────────────
export interface ProjectRepos { repos: { repo: string; added_by: string; added_at: string }[]; checkouts: string[] }

export async function projectRepos(d: Pick<Db, "query">, project: string): Promise<ProjectRepos> {
  const repos = await d.query("select repo, added_by, added_at from project_plugin_repos where project = $1 order by repo", [project]);
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
    await t.query("delete from project_plugin_repos where project = $1 and not (repo = any($2))", [project, keys]);
    for (const repo of keys) {
      await t.query("insert into project_plugin_repos (project, repo, added_by) values ($1, $2, $3) on conflict do nothing", [project, repo, handle]);
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

/** Why this server can't run an instance, as its own host would judge it, or null when it can: the connections must
 * resolve with the secret for their origin, no repo connection may start a command, required settings need values,
 * and no address may be refused. */
async function serverRefusal(r: Resolved, instance: InstanceDef, connections: Record<string, ResolvedConnection>, guard: AddressGuard,
                             unreadable: { repo: string[]; host: string[] }, github: boolean): Promise<string | null> {
  if (!github) return "todo has no GitHub token that reads this repo; give one on Settings → Automation";
  for (const name of bindConnections(r.def, instance).plugin.connections ?? []) {
    const c = connections[name];
    if (c?.kind === "http" && c.auth && !c.secret && unreadable[c.origin === "host" ? "host" : "repo"].includes(name)) {
      return `credential for \`${name}\` doesn't decrypt`;
    }
  }
  const skip = wouldSkip({ plugin: r.def, instance, connections, shipped: r.shipped, allowRepoCommands: false });
  if (skip) return skip;
  for (const name of bindConnections(r.def, instance).plugin.connections ?? []) {
    const c = connections[name];
    const url = c?.url;
    if (url && !(await addressAllowed(url, guard, r.shipped ? c.origin ?? "repo" : "repo", name))) {
      return `connection \`${name}\` is refused by the private-address rule`;
    }
  }
  return null;
}

export interface RepoPlugins {
  /** The repo's config as the host reads it, and its deploy branches: what a CLI runs and computes git facts with. */
  config: PluginConfig;
  track: string[];
  instances: Record<string, InstanceDef[]>;
  grants: Record<string, string[]>;
  /** Each instance says whether this server runs it; a CLI runs only the ones it doesn't. */
  plugins: (Omit<PluginInfo, "instances"> & { instances: (InstanceDef & { server_runs: boolean; server_runs_reason: string | null })[] })[];
  /** Repo connections this server holds a credential for. */
  secrets: string[];
  /** Host connections with a secret, the server's or the project's own, which only shipped plugins receive. */
  host_secrets: string[];
  runs: Record<string, LastRun>;
  errors: string[];
}

/** One repo's plugins as a project sees them, secrets masked. */
export async function repoPlugins(d: Pick<Db, "query">, project: string, repo: string, lookup?: AddressGuard["lookup"]): Promise<RepoPlugins> {
  const instances = await storedInstances(d, project, repo);
  const stored = await loadConfig(d, project, repo);
  const merged = merge(stored, instances);
  const { secrets, unreadable } = await credentials(d, project, repo);
  const usable = merge(stored, await storedInstances(d, project, repo, { secrets: true }));
  const host = await hostSet(d, project, repo);
  const given = { hostConnections: host.connections, secrets: { repo: secrets, host: host.secrets } };
  const connections = { shipped: connectionsFor(given, usable.file, true), custom: connectionsFor(given, usable.file) };
  const guard = guardFor(repo, lookup, host.privateOk);
  const plugins = [];
  for (const p of merged.plugins) {
    const r = usable.resolved.find((x) => x.name === p.name)!;
    const real = usable.plugins.find((x) => x.name === p.name)!;
    const shown = [];
    for (const i of p.instances) {
      const inst = real.instances.find((x) => x.id === i.id) ?? i;
      const why = await serverRefusal(r, inst, connections[r.shipped ? "shipped" : "custom"], guard, { repo: unreadable, host: host.unreadable },
                                      host.github !== null);
      shown.push({ ...masked(i, secretKeysOf(p.settings)), server_runs: why === null, server_runs_reason: why });
    }
    plugins.push({ ...p, instances: shown });
  }
  return {
    config: merged.config, track: stored.track, instances, grants: await storedGrants(d, project, repo), plugins, secrets: Object.keys(secrets).sort(),
    host_secrets: Object.keys(host.secrets).sort(), runs: await lastRuns(d, project, repo), errors: merged.errors,
  };
}
