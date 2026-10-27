// What a repo's plugin config declares, shipped plugins resolved, for a host
// deciding what to run or list without running anything (the CLI's describe mode).
import { pluginsFor, readConfig, type PluginConfig } from "./host";
import type { ConnectionDef, SettingDef, Trigger } from "./types";

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
  connections: Record<string, ConnectionDef>;
  errors: string[];
  track: string[];
}

export function describeConfig(config?: PluginConfig): Described {
  const { file, errors } = readConfig(config);
  const plugins = pluginsFor({ config }, file, errors).map(({ name, def, shipped }) => ({
    name, shipped, connections: def.connections ?? [], on: def.on ?? [], settings: def.settings ?? {},
    ...(def.every !== undefined ? { every: def.every } : {}), ...(def.exclusive ? { exclusive: true } : {}),
    ...(def.per ? { per: def.per } : {}), ...(def.code ? { code: def.code } : {}),
  }));
  return { plugins, connections: file.connections ?? {}, errors, track: file.track ?? [] };
}
