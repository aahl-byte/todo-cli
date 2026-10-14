import type { MetadataRoute } from "next";
import { withBase } from "@/lib/base";

/** A display installs as its own app, opening straight onto its board. */
export async function GET(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const home = withBase(`/display/${encodeURIComponent(key)}`);
  const manifest: MetadataRoute.Manifest = {
    id: home,
    name: `${key} display`,
    short_name: key,
    description: "Read-only board",
    start_url: home,
    scope: `${home}/`,
    display: "fullscreen",
    background_color: "#11151b",
    theme_color: "#11151b",
    icons: [
      { src: `${home}/icons/icon-192.png`, sizes: "192x192", type: "image/png" },
      { src: `${home}/icons/icon-512.png`, sizes: "512x512", type: "image/png" },
      { src: `${home}/icons/icon-maskable-512.png`, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
  return Response.json(manifest, { headers: { "Content-Type": "application/manifest+json" } });
}
