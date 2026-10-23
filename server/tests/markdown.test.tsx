import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "@/components/Markdown";

const html = (text: string, oneLine = false) => renderToStaticMarkup(<Markdown text={text} oneLine={oneLine} />);

describe("markdown", () => {
  it("renders tables, headings, nested lists and keeps single newlines as breaks", () => {
    const out = html("## Plan\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- one\n  - nested\n\nline one\nline two");
    expect(out).toContain("<h2>Plan</h2>");
    expect(out).toContain("<td>1</td>");
    expect(out).toMatch(/<li>one\s*<ul>\s*<li>nested<\/li>/);
    expect(out).toContain("line one<br/>");
  });

  it("only links http(s) and mailto, and only shows images from http(s) or our store", () => {
    const out = html("[x](javascript:alert(1)) [y](https://a.test) ![i](/api/files/p/I/01ARZ3NDEKTSV4RRFFQ69G5FAV.png) ![j](/etc/passwd) <b>raw</b>");
    expect(out).not.toContain("javascript:");
    expect(out).toContain('href="https://a.test" target="_blank" rel="noreferrer"');
    expect(out).toContain('src="/api/files/p/I/01ARZ3NDEKTSV4RRFFQ69G5FAV.png"');
    expect(out).not.toContain("/etc/passwd\"");
    expect(out).not.toContain("<b>");
  });

  it("keeps one line inline", () => {
    expect(html("## **Big** news\n\nmore", true)).toBe('<span class="md"><strong>Big</strong> news</span>');
  });
});

describe("doc references", () => {
  const withDocs = (text: string) => renderToStaticMarkup(<Markdown text={text} docs="/p/p/i/login/docs" />);

  it("link doc:<name> to the doc on its item", () => {
    const out = withDocs("See doc:plan.md, then doc:mock.html.");
    expect(out).toContain('<a href="/p/p/i/login/docs/plan.md" class="doc-ref">doc:plan.md</a>,');
    expect(out).toContain('<a href="/p/p/i/login/docs/mock.html" class="doc-ref">doc:mock.html</a>.');
  });

  it("take a written link to doc:, and encode the name", () => {
    expect(withDocs("[the design](<doc:design v2.md>)")).toContain('<a href="/p/p/i/login/docs/design%20v2.md" class="doc-ref">the design</a>');
  });

  it("leave code and other words alone", () => {
    const out = withDocs("`doc:plan.md` and nodoc:x and https://x.test/doc:y");
    expect(out).not.toContain("doc-ref");
  });

  it("stay text where there is no item to link to", () => {
    const out = html("See doc:plan.md");
    expect(out).toContain('<span class="doc-ref">doc:plan.md</span>');
    expect(out).not.toContain("<a");
  });
});
