// watchtower-session's and rest's instances as cards laid out like the General
// tab's Actions, and back.
import { describe, expect, it } from "vitest";
import { blankCard, cardsOf, instancesOf, REST, WATCHTOWER } from "@/lib/action-cards";
import type { InstanceDef } from "@/lib/plugins/types";

const ROSM: InstanceDef = {
  id: "action-send-to-watchtower", name: "ROSM", on: ["manual", { status: { to: "in-progress" } }],
  settings: { dir: "/src/rosm", prompt: "/todo {{item.id}}\n\ncontext", model: "opus", resumePrompt: "/todo {{item.id}}", link: "https://wt.example" },
};
const NOTIFY: InstanceDef = {
  id: "action-notify", name: "Notify QA", on: ["manual", { status: { from: "review", to: "in-qa" } }],
  settings: { connection: "rest-hooks-example", method: "POST", path: "/notify/{{item.id}}", headers: "X-Token: abc",
              body: { text: "{{item.title}}", dev: "{{item.developer}}" } },
};

describe("Action cards", () => {
  it("show a watchtower instance as the Action's fields, its status moves as any-status → status rows, and save it back unchanged", () => {
    const [card] = cardsOf(WATCHTOWER, [ROSM]);
    expect(card).toMatchObject({ id: "action-send-to-watchtower", name: "ROSM", resume: true, auto: [{ from: "*", to: "in-progress" }],
                                 values: { dir: "/src/rosm", model: "opus", link: "https://wt.example", resumePrompt: "/todo {{item.id}}" } });
    expect(instancesOf(WATCHTOWER, [card])).toEqual({ instances: [ROSM], errors: [], warnings: [] });
  });

  it("drop the resume prompt once resuming is unticked, and keep the button beside the moves it fires on", () => {
    const [card] = cardsOf(WATCHTOWER, [ROSM]);
    const { instances } = instancesOf(WATCHTOWER, [{ ...card, resume: false, auto: [...card.auto, { from: "review", to: "in-qa" }] }]);
    expect(instances[0].settings).not.toHaveProperty("resumePrompt");
    expect(instances[0].on).toEqual(["manual", { status: { to: "in-progress" } }, { status: { from: "review", to: "in-qa" } }]);
  });

  it("show a rest instance's JSON body as text, which saves as text the runner fills value by value, and drop the body for a GET", () => {
    const [card] = cardsOf(REST, [NOTIFY]);
    expect(card.values).toEqual({ connection: "rest-hooks-example", method: "POST", path: "/notify/{{item.id}}", headers: "X-Token: abc",
                                  body: '{\n  "text": "{{item.title}}",\n  "dev": "{{item.developer}}"\n}' });
    const saved = instancesOf(REST, [card]).instances[0];
    expect(JSON.parse(saved.settings!.body as string)).toEqual(NOTIFY.settings!.body);
    expect(instancesOf(REST, [{ ...card, values: { ...card.values, method: "GET" } }]).instances[0].settings).not.toHaveProperty("body");
  });

  it("give a new card an id from its name, a button, and ask for what a rest card needs", () => {
    const named = { ...blankCard(WATCHTOWER), name: "Hand to Claude" };
    expect(instancesOf(WATCHTOWER, [named, { ...named }]).instances.map((i) => [i.id, i.on, i.settings])).toEqual([
      ["hand-to-claude", ["manual"], { prompt: "/todo {{item.id}}" }], ["hand-to-claude-2", ["manual"], { prompt: "/todo {{item.id}}" }]]);
    expect(instancesOf(REST, [{ ...blankCard(REST), auto: [{ from: "*", to: "" }] }]).errors).toEqual([
      "A button has no name.", "A button fires on a move to nothing; pick a status.", "A button needs a connection: where the request goes."]);
  });

  it("keep what a card doesn't show: switched off, git triggers, test mode and other settings", () => {
    const odd: InstanceDef = { id: "x", name: "X", enabled: false, dry_run: true, on: ["push", { status: { to: "done" } }], settings: { connection: "c", extra: 1 } };
    const [card] = cardsOf(REST, [odd]);
    expect(instancesOf(REST, [card]).instances).toEqual([
      { id: "x", name: "X", enabled: false, dry_run: true, on: ["push", { status: { to: "done" } }], settings: { connection: "c", extra: 1, method: "POST" } }]);
  });
});
