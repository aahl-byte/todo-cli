import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocView } from "@/components/DocView";
import { docKind } from "@/lib/doc-view";

const view = (name: string, text: string | null = "") =>
  renderToStaticMarkup(<DocView name={name} kind={docKind(name)} text={text} raw="/raw" download="/raw?download=1" docs="/p/p/i/x/docs" />);

describe("doc view", () => {
  it("renders Markdown through the notes renderer, with doc: links to the same item", () => {
    const out = view("plan.md", "# Plan\n\nsee doc:mock.html");
    expect(out).toContain('<div class="md"><h1>Plan</h1>');
    expect(out).toContain('href="/p/p/i/x/docs/mock.html"');
  });

  it("frames HTML in a sandbox that may run scripts but never shares our origin", () => {
    const out = view("mock.html", "<script>parent.document.title = 'x'</script>");
    expect(out).toMatch(/<iframe class="doc-frame" title="mock.html" sandbox="allow-scripts" srcDoc="&lt;script&gt;/);
    expect(out).not.toContain("allow-same-origin");
  });

  it("pretty-prints and highlights JSON", () => {
    const out = view("data.json", '{"a":[1,"<b>"]}');
    expect(out).toContain('<span class="hljs-attr">&quot;a&quot;</span>');
    expect(out).toContain("\n  ");
    expect(out).toContain("&lt;b&gt;");
    expect(out).not.toContain("<b>");
  });

  it("highlights code by extension", () => {
    expect(view("ci.yaml", "on: push\n")).toContain('<span class="hljs-attr">on:</span>');
    expect(view("site.css", "a { color: red; }")).toContain('class="hljs-selector-tag"');
    expect(view("q.sql", "select 1")).toContain('<span class="hljs-keyword">select</span>');
    expect(view("notes.txt", "<plain>")).toContain("&lt;plain&gt;");
  });

  it("shows media inline and anything else as a download", () => {
    expect(view("shot.png")).toContain('<img class="doc-img" src="/raw" alt="shot.png"/>');
    expect(view("spec.pdf")).toContain('<iframe class="doc-frame pdf" title="spec.pdf" src="/raw">');
    expect(view("call.mp3")).toContain('<audio class="doc-media" controls="" src="/raw">');
    expect(view("demo.mp4")).toContain('<video class="doc-media" controls="" src="/raw">');
    expect(view("bundle.zip")).toContain('href="/raw?download=1"');
    expect(view("plan.md", null)).toContain("Too large to show here");
  });
});
