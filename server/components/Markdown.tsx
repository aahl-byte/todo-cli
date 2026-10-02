// A small, safe Markdown renderer: escapes everything, then allows paragraphs,
// lists, code, emphasis, links and images with http(s) URLs.
import type { ReactNode } from "react";

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\))|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(https?:\/\/[^\s<]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<img key={k} src={m[3]} alt={m[2]} />);
    else if (m[4]) out.push(<a key={k} href={m[6]} rel="noreferrer" target="_blank">{m[5]}</a>);
    else if (m[7]) out.push(<code key={k}>{m[8]}</code>);
    else if (m[9]) out.push(<strong key={k}>{m[10]}</strong>);
    else if (m[11]) out.push(<em key={k}>{m[12]}</em>);
    else if (m[13]) out.push(<a key={k} href={m[13]} rel="noreferrer" target="_blank">{m[13]}</a>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks = String(text ?? "").split(/\n{2,}/);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        if (b.startsWith("```")) return <pre key={i}><code>{b.replace(/^```\w*\n?|```$/g, "")}</code></pre>;
        const lines = b.split("\n");
        if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l))) {
          return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ""), `${i}-${j}`)}</li>)}</ul>;
        }
        return <p key={i}>{lines.flatMap((l, j) => (j ? [<br key={`br${j}`} />, ...inline(l, `${i}-${j}`)] : inline(l, `${i}-${j}`)))}</p>;
      })}
    </div>
  );
}
