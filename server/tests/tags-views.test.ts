import { describe, expect, it } from "vitest";
import { filterCards, tagChoices } from "@/lib/views";
import { tagList } from "@/lib/model";
import { item, world } from "./helpers";

describe("tags on the board", () => {
  it("keep their first spelling and drop case-only twins", () => {
    expect(tagList([" auto-deploy ", "AUTO-DEPLOY", "ui", "", "a,b", 4])).toEqual(["auto-deploy", "ui"]);
  });

  it("filter cards by a tag in any case", () => {
    const cards = [{ uid: "1", extra: { tags: ["Auto-Deploy"] } }, { uid: "2", extra: { tags: ["ui"] } }, { uid: "3", extra: {} }] as any[];
    expect(filterCards(cards, { tag: "auto-deploy" }, "me").map((c) => c.uid)).toEqual(["1"]);
  });

  it("list the project's tags once each", async () => {
    const w = await world();
    await w.one("alice", item("I1", { extra: { tags: ["auto-deploy", "ui"] } }));
    await w.one("alice", item("I2", { extra: { tags: ["UI"] } }));
    await w.one("alice", item("I3", { extra: { tags: "not-a-list" } }));
    expect(await tagChoices(w.d, "p")).toEqual(["auto-deploy", "UI"]);
  });
});
