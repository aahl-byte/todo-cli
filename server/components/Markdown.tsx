// Safe Markdown: GitHub-flavoured (tables, strike, nested lists), no raw HTML,
// links only to http(s) or mailto, images only from http(s) or our file store.
// `doc:<name>` links to that doc of the item the text belongs to.
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { withBase } from "@/lib/base";

const FILE_SRC = /^\/api\/files\/[\w-]+\/[\w-]+\/[0-9A-Z]{26}\.(?:png|jpe?g|gif|webp)$/;
const INLINE = ["a", "code", "em", "strong", "del", "img", "br"];

export function safeUrl(url: string, key: string): string {
  if (key === "src") return /^https?:\/\//i.test(url) || FILE_SRC.test(url) ? url : "";
  return /^(https?:|mailto:|doc:)/i.test(url) ? url : "";
}

const DOC_REF = /(?<![\w:/.-])doc:([^\s<>()[\]"'`]+)/g;

type MdNode = { type: string; value?: string; url?: string; children?: MdNode[] };

/** Bare `doc:<name>` in text becomes a `doc:` link; trailing punctuation stays text. */
function docRefs() {
  const walk = (node: MdNode) => {
    if (!node.children || node.type === "link" || node.type === "linkReference") return;
    node.children = node.children.flatMap((child) => {
      if (child.type !== "text") { walk(child); return [child]; }
      const text = child.value ?? "";
      const out: MdNode[] = [];
      let last = 0;
      for (const m of text.matchAll(DOC_REF)) {
        const name = m[1].replace(/[.,;:!?]+$/, "");
        if (!name) continue;
        if (m.index! > last) out.push({ type: "text", value: text.slice(last, m.index) });
        out.push({ type: "link", url: `doc:${name}`, children: [{ type: "text", value: `doc:${name}` }] });
        last = m.index! + 4 + name.length;
      }
      if (!out.length) return [child];
      if (last < text.length) out.push({ type: "text", value: text.slice(last) });
      return out;
    });
  };
  return (tree: MdNode) => walk(tree);
}

function docName(href: string): string {
  const raw = href.slice(4);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

const FILES = "/api/files";

/** Our stored images load from `files` (a path under the base) in place of the file API. */
const fileUrl = (src: string, files?: string) => withBase(files ? files + src.slice(FILES.length) : src);

const components = (files?: string, docs?: string): Components => ({
  a: ({ node: _node, href, children, ...rest }) => {
    if (href?.startsWith("doc:")) {
      return docs
        ? <a href={withBase(`${docs}/${encodeURIComponent(docName(href))}`)} className="doc-ref">{children}</a>
        : <span className="doc-ref">{children}</span>;
    }
    return href ? <a {...rest} href={href} target="_blank" rel="noreferrer">{children}</a> : <>{children}</>;
  },
  img: ({ node: _node, src, alt }) => (src ? <img src={FILE_SRC.test(String(src)) ? fileUrl(String(src), files) : String(src)} alt={alt ?? ""} /> : <>{alt}</>),
  table: ({ node: _node, children }) => <div className="md-table"><table>{children}</table></div>,
});

/** `docs` is the path of the item's docs, for `doc:` links. */
export function Markdown({ text, oneLine, files, docs }: { text: string; oneLine?: boolean; files?: string; docs?: string }) {
  const md = String(text ?? "");
  if (oneLine) {
    return (
      <span className="md">
        <ReactMarkdown remarkPlugins={[remarkGfm, docRefs]} urlTransform={safeUrl} components={components(files, docs)}
                       allowedElements={INLINE} unwrapDisallowed>
          {md.split("\n")[0].replace(/^\s*(#+|[-*>]|\d+\.)\s+/, "")}
        </ReactMarkdown>
      </span>
    );
  }
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks, docRefs]} urlTransform={safeUrl} components={components(files, docs)}>{md}</ReactMarkdown>
    </div>
  );
}
