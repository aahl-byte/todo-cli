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

/** How a `media` node renders: an image URL, a link, or null for its name only. */
export type MediaRef = (attrs: Record<string, any>) => { image?: string; link?: string } | null;

type Mark = { type: string; attrs?: Record<string, any> };
type MdNode = Node & { marks?: Mark[] };

const encodeHref = (href: string) => href.replace(/[\s)]/g, (c) => encodeURIComponent(c));

function codeSpan(t: string): string {
  return t.includes("`") ? `\`\` ${t} \`\`` : `\`${t}\``;
}

function markText(n: MdNode): string {
  const marks = n.marks ?? [];
  const code = marks.some((m) => m.type === "code");
  let t = n.text ?? "";
  if (!t) return "";
  if (code) t = codeSpan(t);
  for (const m of marks) {
    if (m.type === "strong") t = `**${t}**`;
    else if (m.type === "em") t = `*${t}*`;
    else if (m.type === "strike") t = `~~${t}~~`;
  }
  const link = marks.find((m) => m.type === "link")?.attrs?.href;
  if (link) t = n.text === link && !code ? link : `[${t.replace(/[[\]]/g, "")}](${encodeHref(String(link))})`;
  return t;
}

const cell = (s: string) => s.replace(/\n+/g, " ").replace(/\|/g, "\\|").trim();

/** Atlassian Document Format → GitHub-flavoured Markdown, for notes. */
export function adfToMarkdown(doc: unknown, media?: MediaRef): string {
  if (doc == null) return "";
  if (typeof doc === "string") return doc;

  const inline = (nodes: MdNode[] = []): string => nodes.map((n) => {
    switch (n.type) {
      case "text": return markText(n);
      case "hardBreak": return "\n";
      case "mention": return n.attrs?.text ?? "@someone";
      case "emoji": return n.attrs?.text ?? n.attrs?.shortName ?? "";
      case "status": return n.attrs?.text ?? "";
      case "inlineCard": return n.attrs?.url ? ` ${n.attrs.url} ` : "";
      case "date": {
        const ms = Number(n.attrs?.timestamp);
        return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "";
      }
      case "mediaInline": case "media": return mediaMd(n);
      default: return inline(n.content as MdNode[]);
    }
  }).join("");

  const mediaMd = (n: MdNode): string => {
    const a = n.attrs ?? {};
    const name = String(a.alt ?? a.name ?? "attachment").replace(/[[\]]/g, "");
    if (a.type === "external" && a.url) return `![${name}](${encodeHref(String(a.url))})`;
    const ref = media?.(a);
    if (ref?.image) return `![${name}](${ref.image})`;
    if (ref?.link) return `[📎 ${name}](${encodeHref(ref.link)})`;
    return `📎 ${name}`;
  };

  const block = (n: MdNode, indent = ""): string => {
    const kids = (n.content ?? []) as MdNode[];
    switch (n.type) {
      case "doc": return kids.map((k) => block(k)).filter(Boolean).join("\n\n");
      case "paragraph": return inline(kids).trim();
      case "heading": return `${"#".repeat(Math.min(Math.max(Number(n.attrs?.level) || 1, 1), 6))} ${inline(kids).trim()}`;
      case "rule": return "---";
      case "codeBlock": {
        const body = kids.map((k) => k.text ?? "").join("");
        const fence = body.includes("```") ? "~~~~" : "```";
        return `${fence}${n.attrs?.language ?? ""}\n${body}\n${fence}`;
      }
      case "blockquote": return kids.map((k) => block(k)).join("\n\n").split("\n").map((l) => `> ${l}`).join("\n");
      case "bulletList": case "orderedList":
        return kids.map((li, i) => {
          const bullet = n.type === "bulletList" ? "- " : `${(Number(n.attrs?.order) || 1) + i}. `;
          const inner = ((li.content ?? []) as MdNode[]).map((c) => block(c, indent + " ".repeat(bullet.length))).filter(Boolean);
          const [first = "", ...rest] = inner;
          return [`${indent}${bullet}${first.trimStart()}`, ...rest.map((r) => (r.startsWith(indent + " ") ? r : `${indent}${" ".repeat(bullet.length)}${r}`))].join("\n");
        }).join("\n");
      case "mediaSingle": case "mediaGroup": return kids.map(mediaMd).join("\n");
      case "blockCard": case "embedCard": return n.attrs?.url ?? "";
      case "table": {
        const rows = kids.map((r) => ((r.content ?? []) as MdNode[]).map((c) => cell(((c.content ?? []) as MdNode[]).map((x) => block(x)).join(" "))));
        if (!rows.length) return "";
        const width = Math.max(...rows.map((r) => r.length));
        const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
        const [head, ...body] = rows;
        return [`| ${pad(head).join(" | ")} |`, `|${" --- |".repeat(width)}`, ...body.map((r) => `| ${pad(r).join(" | ")} |`)].join("\n");
      }
      case "panel": case "expand": case "nestedExpand": case "layoutSection": case "layoutColumn":
        return kids.map((k) => block(k, indent)).filter(Boolean).join("\n\n");
      default: return n.text != null || n.type === "text" ? inline([n]) : inline(kids);
    }
  };
  return block(doc as MdNode).replace(/\n{3,}/g, "\n\n").trim();
}
