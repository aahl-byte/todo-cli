import { describe, expect, it } from "vitest";
import { fillExpr, fillJson, fillString, fillUrl, lookup, templateErrors } from "@/lib/plugins/template";
import { search, test as holds, truthy } from "@/lib/plugins/expr";

const scope = {
  item: { id: "fix-login", priority: 3, branches: ["feat/x", "feat/y"], links: [{ type: "pr", url: "https://x/1" }] },
  branch: "feat/x' || true || '",
  settings: { to: "Won't Do", never: ["Done"], flag: false, path: "a\\b`c" },
};

describe("plugin templates", () => {
  it("resolves dotted paths, list indexes included, and misses as undefined", () => {
    expect(lookup(scope, "item.id")).toBe("fix-login");
    expect(lookup(scope, "item.branches.1")).toBe("feat/y");
    expect(lookup(scope, "item.links.0.url")).toBe("https://x/1");
    expect(lookup(scope, "item.nope.deeper")).toBeUndefined();
  });

  it("keeps a lone template's type in json mode and stringifies inside longer strings", () => {
    expect(fillJson({ a: "{{item.priority}}", b: "#{{item.priority}} {{item.id}}", c: ["{{item.branches}}"], d: "{{missing}}", e: 7 }, scope))
      .toEqual({ a: 3, b: "#3 fix-login", c: [["feat/x", "feat/y"]], d: null, e: 7 });
    expect(fillJson(" {{ item.id }} ", scope)).toBe(" fix-login ");
    expect(fillString("x{{missing}}y{{settings.never}}", scope)).toBe('xy["Done"]');
  });

  it("URL-encodes each filled value in url mode", () => {
    expect(fillUrl("/repos/{{item.id}}/pulls/{{branch}}", { item: { id: "a b" }, branch: "feat/x?y" }))
      .toBe("/repos/a%20b/pulls/feat%2Fx%3Fy");
    expect(fillUrl("/x/{{missing}}", {})).toBe("/x/");
  });

  it("fills expressions with quoted literals that stay strings", () => {
    expect(holds("branch == {{branch}}", scope)).toBe(true);
    expect(search("{{branch}}", scope)).toBe("feat/x' || true || '");
    expect(holds("{{branch}} == 'feat/x'", scope)).toBe(false);
    expect(search("{{settings.path}}", scope)).toBe("a\\b`c");
    expect(search("{{settings.to}}", scope)).toBe("Won't Do");
    expect(search("{{item.priority}}", scope)).toBe("3");
    expect(fillExpr("a == {{missing}}", scope)).toBe("a == `\"\"`");
  });

  it("refuses anything but a dotted path inside braces", () => {
    expect(templateErrors("{{item.id}} and {{ branch }}")).toEqual([]);
    expect(templateErrors({ a: ["{{item.id || 'x'}}"], b: "{{}}" })).toEqual([
      "{{item.id || 'x'}} is not a path", "{{}} is not a path"]);
    expect(templateErrors("{{a}} {{b")).toEqual(["unclosed {{ in \"{{a}} {{b\""]);
  });
});

describe("plugin expressions", () => {
  it("follows JMESPath truthiness", () => {
    for (const v of [[], {}, "", false, null, undefined]) expect(truthy(v)).toBe(false);
    for (const v of [[0], { a: 1 }, "x", true, 0]) expect(truthy(v)).toBe(true);
  });

  it("evaluates over the scope", () => {
    expect(holds("!contains(settings.never, settings.to)", scope)).toBe(true);
    expect(holds("settings.flag", scope)).toBe(false);
    expect(search("item.links[?type=='pr'].url | [0]", scope)).toBe("https://x/1");
  });
});
