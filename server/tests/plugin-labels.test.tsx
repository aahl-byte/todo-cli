import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GitFacts } from "@/components/item/GitFacts";
import { PluginBy } from "@/components/item/PluginBy";

describe("plugin attachment labels", () => {
  it("name the plugin and instance quietly, and nothing for a person's attachment", () => {
    expect(renderToStaticMarkup(<PluginBy by="vercel-preview/web" />))
      .toBe('<span class="plugin-by" data-tip="added by the vercel-preview plugin, instance web">vercel-preview · web</span>');
    expect(renderToStaticMarkup(<PluginBy by={undefined} />)).toBe("");
  });

  it("label a plugin's edge in the git facts by the note behind it", () => {
    const out = renderToStaticMarkup(<GitFacts base="/p/p" pluginEdges={{ N1: "db-request/default" }} facts={{
      needs: [{ needs: "https://github.com/acme/db/pull/5", state: "waiting", source: "plugin", note: "N1", evidence: "needs moneyball PR #5" },
              { needs: "branch:x", state: "waiting", source: "git" }],
    }} />);
    expect(out).toContain('<span class="plugin-by" data-tip="added by the db-request plugin, instance default">db-request · default</span>');
    expect(out.match(/plugin-by/g)).toHaveLength(1);
  });
});

describe("the git facts rail", () => {
  it("shows a branch's hint quietly, outside the edges", () => {
    const hint = "feat/b's PR is based on staging; if staging is long-lived, add it under track: in .todo-plugins/plugins.yaml";
    const out = renderToStaticMarkup(<GitFacts base="/p/p" facts={{ branches: [{ name: "feat/b", target: "staging", hint }], needs: [] }} />);
    expect(out).toContain(`<div class="faint git-hint">${hint.replace(/'/g, "&#x27;")}</div>`);
    expect(out).not.toContain("needs");
  });
});
