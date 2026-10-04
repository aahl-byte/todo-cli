import { describe, expect, it } from "vitest";
import { POSTABLE_KINDS, describe as describeResults, safeNext } from "@/lib/action-helpers";
import { safeUrl } from "@/lib/url";

describe("action helpers", () => {
  it("keeps sign-in redirects on this site", () => {
    expect(safeNext("/p/web")).toBe("/p/web");
    expect(safeNext("//evil.example/x")).toBe("/");
    expect(safeNext("/\\evil.example")).toBe("/");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext("/\t/evil.example/x")).toBe("/");
    expect(safeNext("/%09/evil.example")).toBe("/%09/evil.example");
    expect(safeNext("/p/web?x=1#n-2")).toBe("/p/web?x=1#n-2");
    for (const sneaky of ["/..//evil.com", "/.//evil.com", "/%2e%2e//evil.com"]) expect(safeNext(sneaky)).toBe("/");
  });

  it("lets people post only plain note kinds", () => {
    expect(POSTABLE_KINDS).toEqual(["context", "comment", "clarification"]);
  });

  it("describes stale writes with who and when, and any refusal as not applied", () => {
    expect(describeResults([{ op_id: "a", status: "applied", rejected: [
      { field: "status", reason: "stale", server_value: "in-qa", by: "qa", at: "2026-10-02T14:02:00.000Z" }] }]))
      .toMatchObject({ ok: false, message: "qa set status → in-qa", when: "2026-10-02T14:02:00.000Z" });
    expect(describeResults([{ op_id: "a", status: "rejected", reason: "no-item" }]).ok).toBe(false);
    expect(describeResults([{ op_id: "a", status: "rejected", reason: "group-rolled-back" }]).ok).toBe(false);
    expect(describeResults([{ op_id: "a", status: "applied" }]).ok).toBe(true);
  });

  it("renders only http(s) links", () => {
    expect(safeUrl("https://x/pr/1")).toBe("https://x/pr/1");
    expect(safeUrl("data:text/html,<script>")).toBeNull();
    expect(safeUrl("javascript:alert(1)")).toBeNull();
  });
});
