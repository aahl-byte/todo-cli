import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GitFacts, byFolder, fileClashes } from "@/components/item/GitFacts";

const via = "feat/mine";

describe("files other branches change too", () => {
  it("fold a branch's conflicts and overlaps into one entry, its conflicting files split out, most conflicting first", () => {
    const out = fileClashes(
      [{ id: "b", branch: "feat/b", via, files: ["src/a.ts"] }],
      [{ id: "a", branch: "feat/a", via, files: ["README.md"] },
       { id: "b", branch: "feat/b", via, files: ["src/a.ts", "src/c.ts"] }],
    );
    expect(out).toEqual([
      { id: "b", branch: "feat/b", via, conflict: ["src/a.ts"], overlap: ["src/c.ts"] },
      { id: "a", branch: "feat/a", via, conflict: [], overlap: ["README.md"] },
    ]);
  });

  it("group files by folder with a folder's conflicting files first", () => {
    expect(byFolder(["x/fixtures/2.json"], ["x/fixtures/1.json", "x/config.ts", "top.md"])).toEqual([
      { dir: "", files: [{ name: "top.md", conflict: false }] },
      { dir: "x/", files: [{ name: "config.ts", conflict: false }] },
      { dir: "x/fixtures/", files: [{ name: "2.json", conflict: true }, { name: "1.json", conflict: false }] },
    ]);
  });

  it("show each other branch once, collapsed, with a folder's clean files past the first few behind a count", () => {
    const fixtures = Array.from({ length: 6 }, (_, i) => `fx/${i}.json`);
    const html = renderToStaticMarkup(<GitFacts base="/p/p" facts={{
      branches: [{ name: via, in: {} }],
      conflicts: [{ id: "b", branch: "feat/b", via, files: ["fx/0.json"] }],
      overlaps: [{ id: "b", branch: "feat/b", via, files: fixtures }],
    }} />);
    expect(html.match(/class="git-clash"/g)).toHaveLength(1);
    expect(html).toContain("1 conflict");
    expect(html).toContain("6 files");
    expect(html).toContain("6 files");
    expect(html.match(/git-file conflict/g)).toHaveLength(1);
    expect(html).toContain("+2 more files");
    expect(html).not.toContain(" with feat/mine");
  });
});
