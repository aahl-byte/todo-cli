// jira-issue's request block against links mode's, byte for byte, for a
// description with every kind of text node and no images.
import { describe, expect, it } from "vitest";
import { runInstance } from "@/lib/plugins/host";
import { SHIPPED } from "@/lib/plugins/shipped";
import { adfToMarkdown } from "@/lib/jira/adf";
import { appendTicketBlock, ticketBlock } from "@/lib/jira/ticket-block";
import { fakeServer } from "./plugin-fakes";

const DESCRIPTION = { type: "doc", version: 1, content: [
  { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Goal" }] },
  { type: "paragraph", content: [{ type: "text", text: "Export ", marks: [{ type: "strong" }] }, { type: "text", text: "totals", marks: [{ type: "code" }] },
    { type: "hardBreak" }, { type: "text", text: "see docs", marks: [{ type: "link", attrs: { href: "https://x.test/a b" } }] }] },
  { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
    { type: "listItem", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { text: "@Pat" } }] }] }] },
  { type: "codeBlock", attrs: { language: "sql" }, content: [{ type: "text", text: "select 1;" }] },
  { type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "a|b" }] }] }] }] },
] };

describe("jira-issue's request block", () => {
  it("is links mode's block, byte for byte", async () => {
    const issue = { key: "SR-9", self: "https://acme.atlassian.net/rest/api/3/issue/9",
      fields: { summary: "Totals · CSV", status: { name: "Open" }, description: DESCRIPTION, comment: { total: 0, comments: [] } } };
    const server = await fakeServer([{ method: "GET", path: "/rest/api/3/issue/SR-9?fields=summary%2Cdescription%2Cupdated%2Ccomment%2Cattachment", body: issue }]);
    try {
      const { def, code } = SHIPPED["jira-issue"];
      const r = await runInstance({ plugin: def, name: "jira-issue", code, shipped: true, grants: ["post-request"], instance: { id: "default", name: "d" },
        item: { id: "x", uid: "U", title: "t", status: "in-progress", branches: [], jira: ["SR-9"], links: [], requests: ["Build it"] },
        event: { type: "refresh" }, connections: { jira: { kind: "http", url: server.url } }, dryRun: false }, { isolation: "inline" });
      const links = appendTicketBlock("Build it", ticketBlock("SR-9", "Totals · CSV", adfToMarkdown(DESCRIPTION), "https://acme.atlassian.net"));
      expect(r.attached.find((a) => a.kind === "request")).toEqual({ kind: "request", key: "request:jira", text: links });
    } finally {
      await server.close();
    }
  });
});
