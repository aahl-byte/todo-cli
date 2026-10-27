import { describe, expect, it } from "vitest";
import {
  addInstance, canMove, connectionChoices, connectionKeysOf, describeConnections, describeTrigger, draftPlugin, draftTrigger, draftValue, duplicateInstance, editInstance, fieldOf, fieldsOf,
  moveInstance, removeInstance, savedInstances, storedTrigger, storedValue, type PluginShape,
} from "@/lib/plugin-form";
import type { SettingDef } from "@/lib/plugins/types";

const S = (def: Partial<SettingDef>): SettingDef => ({ label: "Thing", type: "text", ...def });

describe("settings fields", () => {
  it("gives every setting type its control", () => {
    const fields = fieldsOf({
      a: S({ type: "text" }), b: S({ type: "long-text" }), c: S({ type: "choice", options: ["x", "y"] }), d: S({ type: "toggle" }),
      e: S({ type: "number" }), f: S({ type: "list" }), g: S({ type: "secret" }),
    });
    expect(fields.map((f) => [f.key, f.control])).toEqual([
      ["a", "text"], ["b", "textarea"], ["c", "select"], ["d", "checkbox"], ["e", "number"], ["f", "list"], ["g", "password"]]);
    expect(fields[2].options).toEqual(["x", "y"]);
  });

  it("shows a choice filled from a connection as a text field with a note", () => {
    const f = fieldOf("to", S({ label: "Jira status", type: "choice", options_from: { tool: "list_statuses" } }));
    expect(f.control).toBe("text");
    expect(f.options).toBeUndefined();
    expect(f.note).toContain("list_statuses");
  });

  it("marks a setting with no default and not optional as required, and shows defaults as placeholders", () => {
    expect(fieldOf("p", S({})).required).toBe(true);
    expect(fieldOf("p", S({ optional: true })).required).toBe(false);
    const d = fieldOf("dir", S({ default: "{{item.dir}}" }));
    expect(d.required).toBe(false);
    expect(d.placeholder).toBe("default: {{item.dir}}");
    expect(fieldOf("t", S({ type: "toggle" })).required).toBe(false);
    expect(fieldOf("l", S({ type: "list" })).required).toBe(false);
    expect(fieldOf("n", S({ scope: "plugin" })).scope).toBe("plugin");
  });
});

describe("template and connection settings", () => {
  it("marks a template setting with a hint on how it fills", () => {
    const f = fieldOf("path", S({ type: "text", template: true }));
    expect(f.template).toBe(true);
    expect(f.note).toBe("A template: {{item.id}} and other fields fill in where it's used, URL-encoded in a path and as JSON values in a JSON body.");
  });

  it("finds the settings a plugin's connections list names, and makes each a choice of connection", () => {
    expect(connectionKeysOf(["{{settings.connection}}", "github", "{{ settings.other }}"])).toEqual(["connection", "other"]);
    const [f] = fieldsOf({ connection: S({ label: "Connection" }) }, ["connection"]);
    expect([f.control, f.connection, f.note]).toEqual(["select", true, "The connection it calls: this repo's, and for a plugin that ships with todo, the project's too, or a new one."]);
  });

  it("offers a custom plugin's instance the repo's connections and github, and a shipped one's the server's too", () => {
    const available = { repo: ["hooks", "jira"], host: ["github", "jira", "watchtower"] };
    expect(connectionChoices(available, false)).toEqual(["github", "hooks", "jira"]);
    expect(connectionChoices(available, true)).toEqual(["github", "hooks", "jira", "watchtower"]);
  });

  it("names a connections list that holds a settings reference in words", () => {
    expect(describeConnections(["{{settings.connection}}"])).toBe("the connection each instance names");
    expect(describeConnections(["jira", "github"])).toBe("jira, github");
  });
});

describe("setting values", () => {
  it("text and long text: empty falls back to the default", () => {
    expect(draftValue(S({}), "abc")).toBe("abc");
    expect(draftValue(S({}), undefined)).toBe("");
    expect(storedValue(S({}), "T", "  abc ", undefined)).toEqual({ value: "abc" });
    expect(storedValue(S({}), "T", "", "abc")).toEqual({});
    expect(storedValue(S({ type: "long-text" }), "T", "line 1\nline 2\n", undefined)).toEqual({ value: "line 1\nline 2\n" });
  });

  it("choice: one of the options, keeping a stored value that isn't one", () => {
    const def = S({ type: "choice", options: ["opus", "sonnet"] });
    expect(storedValue(def, "Model", "opus", undefined)).toEqual({ value: "opus" });
    expect(storedValue(def, "Model", "haiku", undefined)).toEqual({ error: "Model must be one of opus, sonnet" });
    expect(storedValue(def, "Model", "haiku", "haiku")).toEqual({ value: "haiku" });
    expect(storedValue(S({ type: "choice", options_from: { tool: "t" } }), "S", "Done", undefined)).toEqual({ value: "Done" });
  });

  it("toggle: stored only once it differs from the default or was stored before", () => {
    const def = S({ type: "toggle", default: true });
    expect(draftValue(def, undefined)).toBe(true);
    expect(draftValue(def, false)).toBe(false);
    expect(storedValue(def, "T", true, undefined)).toEqual({});
    expect(storedValue(def, "T", false, undefined)).toEqual({ value: false });
    expect(storedValue(def, "T", true, true)).toEqual({ value: true });
  });

  it("number: parsed, or an error", () => {
    const def = S({ type: "number" });
    expect(draftValue(def, 5)).toBe("5");
    expect(storedValue(def, "Count", "12.5", undefined)).toEqual({ value: 12.5 });
    expect(storedValue(def, "Count", "lots", undefined)).toEqual({ error: "Count must be a number" });
    expect(storedValue(def, "Count", "", 3)).toEqual({});
  });

  it("list: one per line", () => {
    const def = S({ type: "list" });
    expect(draftValue(def, ["Done", "Closed"])).toBe("Done\nClosed");
    expect(storedValue(def, "L", "Done\n\n Closed \n", undefined)).toEqual({ value: ["Done", "Closed"] });
    expect(storedValue(def, "L", "", ["Done"])).toEqual({});
    expect(storedValue(S({ type: "list", default: ["x"] }), "L", "", undefined)).toEqual({ value: [] });
  });

  it("secret: shows only that it's set, keeps it when untouched, replaces or clears it", () => {
    const def = S({ type: "secret" });
    expect(draftValue(def, { set: true })).toEqual({ state: "stored" });
    expect(draftValue(def, undefined)).toEqual({ state: "unset" });
    expect(storedValue(def, "K", { state: "stored" }, { set: true })).toEqual({ value: { set: true } });
    expect(storedValue(def, "K", { state: "new", value: "s3cret" }, { set: true })).toEqual({ value: "s3cret" });
    expect(storedValue(def, "K", { state: "new", value: "" }, { set: true })).toEqual({ value: { set: true } });
    expect(storedValue(def, "K", { state: "new", value: "" }, undefined)).toEqual({});
    expect(storedValue(def, "K", { state: "cleared" }, { set: true })).toEqual({ value: null });
    expect(storedValue(def, "K", { state: "cleared" }, undefined)).toEqual({});
    expect(storedValue(def, "K", { state: "unset" }, undefined)).toEqual({});
  });
});

describe("triggers", () => {
  it("round-trip, with * for any status", () => {
    expect(draftTrigger({ status: { to: "review" } })).toEqual({ kind: "status", from: "*", to: "review" });
    expect(storedTrigger({ kind: "status", from: "*", to: "review" })).toEqual({ status: { to: "review" } });
    expect(storedTrigger({ kind: "status", from: "in-progress", to: "*" })).toEqual({ status: { from: "in-progress" } });
    expect(storedTrigger({ kind: "manual", from: "*", to: "*" })).toBe("manual");
    expect(draftTrigger("push")).toEqual({ kind: "push", from: "*", to: "*" });
  });

  it("read as text", () => {
    expect(describeTrigger({ status: { to: "review" } })).toBe("→ review");
    expect(describeTrigger({ status: { from: "todo", to: "*" } })).toBe("todo → *");
    expect(describeTrigger({ status: {} })).toBe("any status move");
    expect(describeTrigger("deployment")).toBe("deployment");
  });
});

const WATCH: PluginShape = {
  on: ["manual"],
  settings: {
    prompt: { label: "Prompt", type: "long-text", default: "/todo {{item.id}}" },
    model: { label: "Model", type: "choice", options: ["opus", "sonnet"], optional: true },
    token: { label: "Token", type: "secret", optional: true },
    never: { label: "Never move to", type: "list", scope: "plugin" },
  },
};

describe("instances", () => {
  const start = { id: "start", name: "Start agent", on: ["manual" as const], settings: { prompt: "/todo {{item.id}}", token: { set: true }, never: ["Done"] } };
  const review = { id: "review", name: "Review agent", on: [{ status: { to: "review" } }], settings: { never: ["Done"] } };
  const draft = () => draftPlugin(WATCH, [start, review]);

  it("draft each instance with its triggers and settings, and plugin-scope settings once", () => {
    const d = draft();
    expect(d.shared).toEqual({ never: "Done" });
    expect(d.instances.map((i) => [i.id, i.name, i.inherit, i.triggers])).toEqual([
      ["start", "Start agent", false, [{ kind: "manual", from: "*", to: "*" }]],
      ["review", "Review agent", false, [{ kind: "status", from: "*", to: "review" }]]]);
    expect(d.instances[0].settings).toEqual({ prompt: "/todo {{item.id}}", model: "", token: { state: "stored" } });
  });

  it("save as they were loaded", () => {
    const out = savedInstances(WATCH, draft());
    expect(out.errors).toEqual([]);
    expect(out.instances).toEqual([
      { id: "start", name: "Start agent", on: ["manual"], settings: { prompt: "/todo {{item.id}}", token: { set: true }, never: ["Done"] } },
      { id: "review", name: "Review agent", on: [{ status: { to: "review" } }], settings: { never: ["Done"] } }]);
  });

  it("write a plugin-scope setting into every instance", () => {
    const out = savedInstances(WATCH, { ...draft(), shared: { never: "Done\nClosed" } });
    expect(out.instances.map((i) => i.settings?.never)).toEqual([["Done", "Closed"], ["Done", "Closed"]]);
  });

  it("switch, rename, retrigger, label and dry-run an instance", () => {
    let d = draft();
    const k = d.instances[1].key;
    d = editInstance(d, k, { enabled: false, name: "Reviewer", inherit: true, button: "Review", dryRun: true });
    const [, r] = savedInstances(WATCH, d).instances;
    expect(r).toEqual({ id: "review", name: "Reviewer", enabled: false, button: "Review", dry_run: true, settings: { never: ["Done"] } });
  });

  it("add, duplicate without secrets, and remove", () => {
    let d = addInstance(WATCH, draft());
    expect(d.instances[2]).toMatchObject({ id: "instance", storedAs: null, inherit: true });
    d = duplicateInstance(WATCH, d, d.instances[0].key);
    expect(d.instances.map((i) => i.id)).toEqual(["start", "start-copy", "review", "instance"]);
    expect(d.instances[1]).toMatchObject({ name: "Start agent (copy)", storedAs: null });
    expect(d.instances[1].settings.token).toEqual({ state: "unset" });
    d = duplicateInstance(WATCH, d, d.instances[0].key);
    expect(d.instances[1].id).toBe("start-copy-2");
    d = removeInstance(d, d.instances[1].key);
    expect(d.instances.map((i) => i.id)).toEqual(["start", "start-copy", "review", "instance"]);
    const saved = savedInstances(WATCH, d).instances;
    expect(saved[1]).toEqual({ id: "start-copy", name: "Start agent (copy)", on: ["manual"], settings: { prompt: "/todo {{item.id}}", never: ["Done"] } });
  });

  it("reorder the instances the dashboard added", () => {
    let d = draft();
    const [a, b] = d.instances.map((i) => i.key);
    expect(canMove(d, a, -1)).toBe(false);
    d = moveInstance(d, b, -1);
    expect(d.instances.map((i) => i.id)).toEqual(["review", "start"]);
    expect(savedInstances(WATCH, d).instances.map((i) => i.id)).toEqual(["review", "start"]);
    expect(moveInstance(d, a, 1)).toBe(d);
  });

  it("refuse bad or repeated ids and bad values, and warn about empty required settings", () => {
    const shape: PluginShape = { settings: { project: { label: "Project", type: "text" }, n: { label: "N", type: "number", optional: true } } };
    let d = draftPlugin(shape, [{ id: "a", name: "a" }, { id: "b", name: "b" }]);
    d = editInstance(d, d.instances[1].key, { id: "a" });
    d = editInstance(d, d.instances[0].key, { settings: { project: "", n: "x" } });
    const out = savedInstances(shape, d);
    expect(out.errors).toEqual(["a: N must be a number", "two instances have the id a"]);
    expect(out.warnings).toContain("a: Project is empty, so it's skipped until it has a value");
    d = editInstance(d, d.instances[1].key, { id: "b/c" });
    expect(savedInstances(shape, d).errors).toContain(`"b/c" isn't an instance id: letters, digits, . _ and -, starting with a letter or digit`);
  });

  it("warn that a renamed instance leaves its secrets behind", () => {
    let d = draft();
    d = editInstance(d, d.instances[0].key, { id: "begin" });
    expect(savedInstances(WATCH, d).warnings).toContain("begin: its secrets are stored under start, so a new id needs them entered again");
  });
});

describe("a stored secret", () => {
  it("is kept untouched, then cleared on request", () => {
    const secretShape: PluginShape = { settings: { token: { label: "Token", type: "secret", optional: true } } };
    let d = draftPlugin(secretShape, [{ id: "web", name: "Web", settings: { token: { set: true } } }]);
    expect(savedInstances(secretShape, d).instances).toEqual([{ id: "web", name: "Web", settings: { token: { set: true } } }]);
    d = editInstance(d, d.instances[0].key, { settings: { token: { state: "cleared" } } });
    expect(savedInstances(secretShape, d).instances).toEqual([{ id: "web", name: "Web", settings: { token: null } }]);
  });
});
