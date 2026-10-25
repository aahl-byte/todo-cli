// What a repo's plugin file declares, shipped plugins resolved, for a host
// deciding what to run or list without running anything (the CLI's describe mode).
import { pluginsFor, type EventInput } from "./host";
import { parsePlugins } from "./load";
import { ALWAYS_ON } from "./shipped";
import type { ConnectionDef, InstanceDef, SettingDef, Trigger } from "./types";

export interface PluginSummary {
  name: string;
  shipped: boolean;
  connections: string[];
  on: Trigger[];
  every?: string;
  exclusive?: boolean;
  per?: string;
  code?: string;
  settings: Record<string, SettingDef>;
}

export interface Described {
  plugins: PluginSummary[];
  /** The repo file's own instances, by plugin, after load. */
  instances: Record<string, InstanceDef[]>;
  /** Plugins that lost an instance at load, so they get no implicit default. */
  dropped: string[];
  connections: Record<string, ConnectionDef>;
  errors: string[];
  track: string[];
}

export function describeRepo(repo?: EventInput["repo"]): Described {
  const loaded = repo ? parsePlugins(repo.text, { extraPlugins: ALWAYS_ON }) : { file: {}, errors: [], droppedInstances: [] };
  const { file } = loaded;
  const errors = [...loaded.errors];
  const plugins = pluginsFor({ repo } as EventInput, file, errors).map(({ name, def, shipped }) => ({
    name, shipped, connections: def.connections ?? [], on: def.on ?? [], settings: def.settings ?? {},
    ...(def.every !== undefined ? { every: def.every } : {}), ...(def.exclusive ? { exclusive: true } : {}),
    ...(def.per ? { per: def.per } : {}), ...(def.code ? { code: def.code } : {}),
  }));
  return { plugins, instances: file.instances ?? {}, dropped: loaded.droppedInstances, connections: file.connections ?? {},
           errors, track: file.track ?? [] };
}
