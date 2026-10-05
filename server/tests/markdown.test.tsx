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
