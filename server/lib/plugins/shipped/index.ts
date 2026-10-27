// Plugins that ship with todo. A repo enables one with `<name>: {use: shipped}`;
// pr-link runs for every repo.
import { parse } from "yaml";
import { pluginErrors } from "../load";
import type { PluginDef } from "../types";
import { SOURCES } from "./sources";

export interface ShippedPlugin { def: PluginDef; code?: string }

/** Shipped plugins every repo gets without asking. */
export const ALWAYS_ON = ["pr-link"];

function load(): Record<string, ShippedPlugin> {
  const out: Record<string, ShippedPlugin> = {};
  for (const [file, text] of Object.entries(SOURCES)) {
    if (!file.endsWith(".yaml")) continue;
    const name = file.slice(0, -".yaml".length);
    const def = parse(text) as PluginDef;
    const errors = pluginErrors(name, def, { shipped: true });
    if (def.code && !(def.code in SOURCES)) errors.push(`plugin ${name}: ${def.code} isn't shipped beside it`);
    if (errors.length) throw new Error(errors.join("\n"));
    out[name] = { def, code: def.code ? SOURCES[def.code] : undefined };
  }
  return out;
}

export const SHIPPED: Record<string, ShippedPlugin> = load();

/** Whether a plugin of this name ships with todo; names every object inherits, such as toString, don't. */
export const isShipped = (name: string) => Object.hasOwn(SHIPPED, name);
