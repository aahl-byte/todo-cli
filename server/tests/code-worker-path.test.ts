import { describe, expect, it } from "vitest";
import { workerPath } from "@/lib/plugins/code-runner";

describe("the code worker's file", () => {
  it("is handed to Worker as a path, whatever URL class built its address", () => {
    class OtherUrl { constructor(private readonly href: string) {} toString() { return this.href; } }
    expect(workerPath(new OtherUrl("file:///srv/app/server/assets/code-worker.mjs") as unknown as URL)).toBe("/srv/app/server/assets/code-worker.mjs");
    expect(workerPath(new URL("file:///srv/a%20b/w.mjs"))).toBe("/srv/a b/w.mjs");
    expect(workerPath("/srv/w.mjs")).toBe("/srv/w.mjs");
  });
});
