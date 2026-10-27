// The Jira triggers jira-transition's editor shows: wildcard moves, first match
// wins, and the rows ↔ instances mapping a save and a move-over share.
import { describe, expect, it } from "vitest";
import { describeMove, outboundTarget, validateRules, type OutboundRules } from "@/lib/jira/rules";
import { pluginRules, ruleInstances, rulesOf, type PluginRules } from "@/lib/jira/plugin-rules";
import { STATUSES } from "@/lib/model";

const rules = (triggers: OutboundRules["triggers"], never: string[] = []): OutboundRules => ({ writes: true, never, triggers });

describe("wildcard triggers", () => {
  it("match any status on a * side, and the first match wins", () => {
    const r = rules([{ from: "*", to: "done", jira: "Done" }, { from: "review", to: "done", jira: "Closed" }]);
    expect(outboundTarget(r, "review", "done")).toBe("Done");
    expect(describeMove(r, "in-qa", "done")).toBe("moves Jira to Done.");
    expect(describeMove(r, "done", "review")).toBe("no trigger.");
  });

  it("are errors for the bridge and allowed for the plugin, which warns about a trigger an earlier one hides", () => {
    const r = rules([{ from: "*", to: "done", jira: "Done" }, { from: "review", to: "done", jira: "Closed" }, { from: "*", to: "*", jira: "Open" }]);
    expect(validateRules(r, STATUSES).filter((p) => p.level === "error").map((p) => p.message)).toEqual([
      "The trigger * → done names *, which isn't a todo status.", "The trigger * → * names *, which isn't a todo status.",
    ]);
    expect(validateRules(r, STATUSES, null, { any: true })).toEqual([
      { level: "warning", message: "The trigger review → done never runs: * → done above it matches first." },
    ]);
  });
});

const instance = (id: string, from: string | undefined, to: string | undefined, jira: string, extra: Record<string, unknown> = {}) =>
  ({ id, name: `${from} → ${to}: Jira ${jira}`, on: [{ status: { ...(from ? { from } : {}), ...(to ? { to } : {}) } }],
     settings: { to: jira, never: ["Done"] }, ...extra });

describe("jira-transition's rows and instances", () => {
  it("read one row per instance, in order, with * for a side the trigger leaves open and never from the plugin setting", () => {
    const p = pluginRules([instance("a", "review", "in-qa", "QA"), instance("b", undefined, "done", "Closed", { dry_run: true })]);
    expect(p.never).toEqual(["Done"]);
    expect(p.triggers.map((t) => [t.from, t.to, t.jira, t.id, t.live])).toEqual([["review", "in-qa", "QA", "a", true], ["*", "done", "Closed", "b", false]]);
    expect(p.writes).toBe(null);
  });

  it("split an instance with several status triggers into adjacent rows, and keep one with a button as it is", () => {
    const two = { id: "two", name: "x", on: [{ status: { from: "a", to: "b" } }, { status: { to: "c" } }], settings: { to: "QA" } };
    const button = { id: "btn", name: "Press", on: ["manual"], settings: { to: "QA" } };
    const p = pluginRules([two, button]);
    expect(p.triggers.map((t) => [t.from, t.to, t.id])).toEqual([["a", "b", "two"], ["*", "c", "two-2"], ["", "", "btn"]]);
    expect(p.triggers[2].kept).toEqual(button);
    expect(p.writes).toBe(true);
  });

  it("save each row as one instance with its trigger, Jira status and the plugin-wide never list, keeping ids and test mode, a new row in test mode", () => {
    const p: PluginRules = { writes: null, never: ["Done"], triggers: [
      { from: "review", to: "in-qa", jira: "QA", id: "a", live: true },
      { from: "*", to: "done", jira: " Closed ", id: "b", live: false },
      { from: "todo", to: "in-progress", jira: "In Progress" },
    ] };
    expect(ruleInstances(p)).toEqual([
      { id: "a", name: "review → in-qa: Jira QA", on: [{ status: { from: "review", to: "in-qa" } }], settings: { to: "QA", never: ["Done"] } },
      { id: "b", name: "* → done: Jira Closed", on: [{ status: { to: "done" } }], settings: { to: "Closed", never: ["Done"] }, dry_run: true },
      { id: "jira-todo-in-progress", name: "todo → in-progress: Jira In Progress", on: [{ status: { from: "todo", to: "in-progress" } }],
        settings: { to: "In Progress", never: ["Done"] }, dry_run: true },
    ]);
  });

  it("set every row's test mode from the switch once it's flipped, and give a new row the switch's state", () => {
    const p: PluginRules = { writes: false, never: [], triggers: [{ from: "a", to: "b", jira: "X", id: "a", live: true }, { from: "c", to: "d", jira: "Y" }] };
    expect(ruleInstances(p).map((i) => i.dry_run)).toEqual([true, true]);
    expect(ruleInstances({ ...p, writes: true }).map((i) => i.dry_run)).toEqual([undefined, undefined]);
  });

  it("round-trips the bridge's triggers through instances, and refuses what the bridge can't hold", () => {
    const bridge = rules([{ from: "review", to: "in-qa", jira: "QA" }, { from: "in-qa", to: "done", jira: "Done" }], ["UAT"]);
    const back = rulesOf(ruleInstances({ writes: false, never: bridge.never, triggers: bridge.triggers }));
    expect(back).toEqual({ rules: { writes: false, never: ["UAT"], triggers: bridge.triggers }, problems: [] });
    const wild = rulesOf([instance("w", undefined, "done", "Done"), { id: "btn", name: "Press", on: ["manual"], settings: { to: "QA" } }]);
    expect(wild.problems).toEqual([
      "The trigger * → done can't go back: the Jira bridge needs both statuses.",
      "Press runs on a button press, which the Jira bridge can't do.",
    ]);
  });
});
