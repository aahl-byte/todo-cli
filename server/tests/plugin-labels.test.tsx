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
