"use client";
// Live status: poll the project's changes feed (and the inbox) every 3 s while
// the tab is visible; on change, refresh the server components and flash what
// changed.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const EVERY_MS = 3000;

export function Live({ project, cursor }: { project?: string; cursor?: number }) {
  const router = useRouter();
  const at = useRef(cursor ?? 0);
  const [online, setOnline] = useState(true);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const box = await fetch("/api/inbox", { cache: "no-store" });
        if (box.ok) setUnread((await box.json()).unread ?? 0);
        if (project) {
          const res = await fetch(`/api/projects/${encodeURIComponent(project)}/changes?since=${at.current}&limit=200`, { cache: "no-store" });
          if (!res.ok) throw new Error(String(res.status));
          const body = await res.json();
          if (body.changes?.length) {
            at.current = body.cursor;
            router.refresh();
            const uids = new Set<string>(body.changes.flatMap((c: any) => [c.uid, c.item_uid]));
            setTimeout(() => {
              document.querySelectorAll<HTMLElement>("[data-uid]").forEach((el) => {
                if (uids.has(el.dataset.uid!)) {
                  el.classList.remove("flash");
                  void el.offsetWidth;
                  el.classList.add("flash");
                }
              });
            }, 300);
          }
        }
        setOnline(true);
      } catch {
        setOnline(false);
      }
    };
    // A page that reads notices (opening an item) reports the new count.
    const onUnread = (e: Event) => setUnread(Number((e as CustomEvent).detail) || 0);
    window.addEventListener("todo:unread", onUnread);
    const id = setInterval(() => { if (!stop) void tick(); }, EVERY_MS);
    void tick();
    return () => { stop = true; clearInterval(id); window.removeEventListener("todo:unread", onUnread); };
  }, [project, router]);

  return (
    <>
      <Link href="/inbox" className="label">Inbox{unread > 0 && <span className="count">{unread}</span>}</Link>
      <span className={online ? "live" : "live off"} data-tip={online ? "live" : "offline — retrying"} aria-label={online ? "live" : "offline"} />
    </>
  );
}
