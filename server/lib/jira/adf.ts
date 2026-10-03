// Atlassian Document Format ↔ plain text, enough for descriptions and comments.

type Node = { type?: string; text?: string; content?: Node[]; attrs?: Record<string, any> };

const BLOCKS = new Set(["paragraph", "heading", "blockquote", "codeBlock", "listItem", "rule", "mediaSingle"]);

export function adfToText(doc: unknown): string {
  if (doc == null) return "";
  if (typeof doc === "string") return doc;
  const out: string[] = [];
  const walk = (n: Node, prefix = "") => {
    if (n.type === "text") {
      out.push(n.text ?? "");
      return;
    }
    if (n.type === "hardBreak") {
      out.push("\n");
      return;
    }
    if (n.type === "mention") {
      out.push(n.attrs?.text ?? "@someone");
      return;
    }
    if (n.type === "inlineCard" || n.type === "blockCard" || n.type === "embedCard") {
      out.push(n.attrs?.url ?? "");
      if (n.type !== "inlineCard") out.push("\n\n");
      return;
    }
    if (n.type === "emoji") {
      out.push(n.attrs?.text ?? n.attrs?.shortName ?? "");
      return;
    }
    if (n.type === "date") {
      const ms = Number(n.attrs?.timestamp);
      out.push(Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "");
      return;
    }
    if (n.type === "status") {
      out.push(n.attrs?.text ?? "");
      return;
    }
    if (n.type === "bulletList" || n.type === "orderedList") {
      (n.content ?? []).forEach((li, i) => {
        out.push(n.type === "bulletList" ? "- " : `${i + 1}. `);
        walk(li, prefix);
      });
      return;
    }
    for (const c of n.content ?? []) walk(c, prefix);
    if (n.type && BLOCKS.has(n.type)) out.push("\n\n");
  };
  walk(doc as Node);
  return out.join("").replace(/\n{3,}/g, "\n\n").trim();
}

export function textToAdf(text: string) {
  const paragraphs = text.replace(/\s+$/, "").split(/\n{2,}/).map((p) => ({
    type: "paragraph",
    // Jira rejects empty text nodes, so blank lines become bare breaks.
    content: p.split("\n").flatMap((line, i) => [
      ...(i ? [{ type: "hardBreak" }] : []),
      ...(line ? [{ type: "text", text: line }] : []),
    ]),
  }));
  return { type: "doc", version: 1, content: paragraphs };
}
