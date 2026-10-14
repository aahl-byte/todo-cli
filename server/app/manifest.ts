import type { MetadataRoute } from "next";
import { APP_NAME, withBase } from "@/lib/base";

export default function manifest(): MetadataRoute.Manifest {
  return {
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
}
