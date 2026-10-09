"use client";
// Marks board cards whose Watchtower session is working or waiting, polling
// while the tab is visible. Cards are server-rendered, so it sets an attribute.
import { useEffect } from "react";
import { withBase } from "@/lib/base";

const EVERY_MS = 5_000;

export function SessionWatch({ project }: { project: string }) {
  useEffect(() => {
    let live = true;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch(withBase(`/api/projects/${encodeURIComponent(project)}/sessions`), { cache: "no-store" });
        if (!res.ok || !live) return;
        const items: Record<string, { status: string; waitingFor: string | null }> = (await res.json()).items ?? {};
        document.querySelectorAll<HTMLElement>(".card[data-uid]").forEach((el) => {
          const s = items[el.dataset.uid!];
          if (s) el.dataset.session = s.status;
          else delete el.dataset.session;
        });
      } catch { /* the next tick retries */ }
    };
    void tick();
    const id = setInterval(() => void tick(), EVERY_MS);
    return () => { live = false; clearInterval(id); };
  }, [project]);
  return null;
}
