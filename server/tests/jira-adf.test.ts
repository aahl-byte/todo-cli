import { describe, expect, it } from "vitest";
import { adfToText } from "@/lib/jira/adf";

describe("jira rich text", () => {
  it("converts links, marks, headings, lists, code and tables to Markdown", async () => {
    const { adfToMarkdown } = await import("@/lib/jira/adf");
    const t = (text: string, marks: any[] = []) => ({ type: "text", text, marks });
    const p = (...content: any[]) => ({ type: "paragraph", content });
    const doc = { type: "doc", content: [
      { type: "heading", attrs: { level: 2 }, content: [t("Plan")] },
      p(t("See "), t("PR 215", [{ type: "link", attrs: { href: "https://github.com/x/y/pull/215" } }]), t(" and "),
        t("https://a.test/b", [{ type: "link", attrs: { href: "https://a.test/b" } }]), t(" with "), t("ro_id", [{ type: "code" }]),
        t(" and "), t("bold", [{ type: "strong" }])),
      { type: "bulletList", content: [{ type: "listItem", content: [p(t("one")),
        { type: "bulletList", content: [{ type: "listItem", content: [p(t("nested"))] }] }] }] },
      { type: "codeBlock", attrs: { language: "sql" }, content: [{ type: "text", text: "select 1;\n\nselect 2;" }] },
      { type: "table", content: [
        { type: "tableRow", content: [{ type: "tableHeader", content: [p(t("a"))] }, { type: "tableHeader", content: [p(t("b|c"))] }] },
        { type: "tableRow", content: [{ type: "tableCell", content: [p(t("1"))] }, { type: "tableCell", content: [p(t("2"))] }] }] },
      { type: "mediaSingle", content: [{ type: "media", attrs: { type: "file", id: "m1", alt: "shot.png" } }] },
      { type: "mediaSingle", content: [{ type: "media", attrs: { type: "file", id: "m2", alt: "spec.pdf" } }] },
    ] };
    const md = adfToMarkdown(doc, (a) => (a.id === "m1" ? { image: "/api/files/p/I/ABC.png" } : null));
    expect(md).toBe([
      "## Plan",
      "See [PR 215](https://github.com/x/y/pull/215) and https://a.test/b with `ro_id` and **bold**",
      "- one\n  - nested",
      "```sql\nselect 1;\n\nselect 2;\n```",
      "| a | b\\|c |\n| --- | --- |\n| 1 | 2 |",
      "![shot.png](/api/files/p/I/ABC.png)",
      "📎 spec.pdf",
    ].join("\n\n"));
  });

  it("keeps smart links, emoji, dates and status lozenges from ADF", () => {
    const doc = { type: "doc", content: [{ type: "paragraph", content: [
      { type: "text", text: "See " }, { type: "inlineCard", attrs: { url: "https://github.com/acme/pr/1" } },
      { type: "text", text: " " }, { type: "emoji", attrs: { shortName: ":tada:", text: "🎉" } },
      { type: "text", text: " by " }, { type: "date", attrs: { timestamp: "1790985600000" } },
      { type: "text", text: " " }, { type: "status", attrs: { text: "BLOCKED" } }] }] };
    expect(adfToText(doc)).toBe("See https://github.com/acme/pr/1 🎉 by 2026-10-03 BLOCKED");
  });

  it("writes ADF Jira accepts: no empty text nodes", async () => {
    const { textToAdf } = await import("@/lib/jira/adf");
    const doc = textToAdf("line one\n\nline two\nthree\n");
    const texts = JSON.stringify(doc).match(/"text":"[^"]*"/g)!;
    expect(texts.every((t) => t !== '"text":""')).toBe(true);
    expect(adfToText(doc)).toBe("line one\n\nline two\nthree");
  });
});
