// One doc, rendered for reading by its kind: Markdown through the notes
// renderer, HTML in a sandboxed frame with an opaque origin, JSON pretty-printed,
// code highlighted, media inline, anything else as a download.
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { docExtOf, LANGUAGES, type DocKind } from "@/lib/doc-view";
import { Markdown } from "./Markdown";

const GRAMMARS = { bash, c, cpp, csharp, css, go, ini, java, javascript, json, kotlin, markdown, php, python, ruby, rust, sql, swift, typescript, xml, yaml };
for (const [name, grammar] of Object.entries(GRAMMARS)) if (!hljs.getLanguage(name)) hljs.registerLanguage(name, grammar);
if (!hljs.getLanguage("plaintext")) hljs.registerLanguage("plaintext", () => ({ name: "plaintext", contains: [] }));

/** Highlighted HTML for `text` in the language its doc name gives; hljs escapes the text. */
export function highlight(text: string, name: string): string {
  return hljs.highlight(text, { language: LANGUAGES[docExtOf(name)] ?? "plaintext", ignoreIllegals: true }).value;
}

/** JSON indented two spaces; text that doesn't parse stays as written. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function DocView({ name, kind, text, raw, download, docs }: {
  name: string; kind: DocKind;
  /** The doc as text, for the kinds rendered from it; null when too large to show. */
  text: string | null;
  /** Where the browser loads the doc's bytes. */
  raw: string;
  download: string;
  /** This item's docs path, for `doc:` links in a Markdown doc. */
  docs: string;
}) {
  const textual = kind === "markdown" || kind === "html" || kind === "json" || kind === "code" || kind === "text";
  if (textual && text === null) {
    return <p className="faint">Too large to show here. <a href={download}>Download {name}</a>.</p>;
  }
  switch (kind) {
    case "markdown":
      return <div className="doc-md"><Markdown text={text!} docs={docs} /></div>;
    case "html":
      return <iframe className="doc-frame" title={name} sandbox="allow-scripts" srcDoc={text!} />;
    case "json":
      return <Code html={highlight(prettyJson(text!), name)} />;
    case "code":
      return <Code html={highlight(text!, name)} />;
    case "text":
      return <pre className="doc-code"><code>{text}</code></pre>;
    case "image":
      return <img className="doc-img" src={raw} alt={name} />;
    case "pdf":
      return <iframe className="doc-frame pdf" title={name} src={raw} />;
    case "audio":
      return <audio className="doc-media" controls src={raw} />;
    case "video":
      return <video className="doc-media" controls src={raw} />;
    default:
      return <p><a className="btn" href={download}>Download {name}</a></p>;
  }
}

function Code({ html }: { html: string }) {
  return <pre className="doc-code"><code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /></pre>;
}
