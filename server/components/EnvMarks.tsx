import { ENVIRONMENTS } from "@/lib/model";

/** D S P, lit for each environment an item's work is in. */
export function EnvMarks({ envs }: { envs: unknown }) {
  const on: string[] = Array.isArray(envs) ? envs : [];
  if (!on.length) return null;
  return (
    <span className="envs" data-tip={`in ${on.join(", ")}`}>
      {Object.entries(ENVIRONMENTS).map(([env, label]) => <span key={env} className={on.includes(env) ? "on" : ""}>{label}</span>)}
    </span>
  );
}
