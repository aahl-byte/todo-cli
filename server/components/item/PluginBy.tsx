/** A quiet label naming the plugin and instance that attached something: `pr-link · default`. */
export function PluginBy({ by }: { by: unknown }) {
  if (typeof by !== "string" || !by) return null;
  const [plugin, ...rest] = by.split("/");
  const instance = rest.join("/");
  return (
    <span className="plugin-by" data-tip={`added by the ${plugin} plugin${instance ? `, instance ${instance}` : ""}`}>
      {plugin}{instance ? ` · ${instance}` : ""}
    </span>
  );
}
