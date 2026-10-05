// Safe Markdown: GitHub-flavoured (tables, strike, nested lists), no raw HTML,
// links only to http(s) or mailto, images only from http(s) or our file store.
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

const FILE_SRC = /^\/api\/files\/[\w-]+\/[\w-]+\/[0-9A-Z]{26}\.(?:png|jpe?g|gif|webp)$/;
const INLINE = ["a", "code", "em", "strong", "del", "img", "br"];

export function safeUrl(url: string, key: string): string {
  if (key === "src") return /^https?:\/\//i.test(url) || FILE_SRC.test(url) ? url : "";
  return /^(https?:|mailto:)/i.test(url) ? url : "";
}

const components: Components = {
  a: ({ node: _node, href, children, ...rest }) => href
    ? <a {...rest} href={href} target="_blank" rel="noreferrer">{children}</a>
    : <>{children}</>,
  img: ({ node: _node, src, alt }) => (src ? <img src={String(src)} alt={alt ?? ""} /> : <>{alt}</>),
  table: ({ node: _node, children }) => <div className="md-table"><table>{children}</table></div>,
};

export function Markdown({ text, oneLine }: { text: string; oneLine?: boolean }) {
  const md = String(text ?? "");
  if (oneLine) {
    return (
      <span className="md">
        <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={safeUrl} components={components}
                       allowedElements={INLINE} unwrapDisallowed>
          {md.split("\n")[0].replace(/^\s*(#+|[-*>]|\d+\.)\s+/, "")}
        </ReactMarkdown>
      </span>
    );
  }
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} urlTransform={safeUrl} components={components}>{md}</ReactMarkdown>
    </div>
  );
}
