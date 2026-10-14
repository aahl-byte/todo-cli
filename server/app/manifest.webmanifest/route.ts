import type { MetadataRoute } from "next";
import { APP_NAME, withBase } from "@/lib/base";

// A route rather than app/manifest.ts, so the layout can link it with
// credentials: the sign-in proxy in front of the app refuses cookieless fetches.
export function GET() {
  const manifest: MetadataRoute.Manifest = {
    id: withBase("/"),
    name: APP_NAME,
    short_name: APP_NAME,
    description: "Team todo dashboard",
    start_url: withBase("/"),
    scope: withBase("/"),
    display: "standalone",
    background_color: "#11151b",
    theme_color: "#11151b",
    icons: [
      { src: withBase("/icon-192.png"), sizes: "192x192", type: "image/png" },
      { src: withBase("/icon-512.png"), sizes: "512x512", type: "image/png" },
      { src: withBase("/icon-maskable-512.png"), sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
  return Response.json(manifest, { headers: { "Content-Type": "application/manifest+json" } });
}
