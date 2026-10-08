"use client";
// Pinned items down the left edge: full board cards, or a thin strip of tiles
// that widens on hover to show titles.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { pin } from "@/app/item-actions";
import { PINS_COOKIE } from "@/lib/filters";
import type { Card } from "@/lib/views";
import { BoardCard } from "./BoardCard";

function initials(title: string) {
  const words = title.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "·";
}

/** Ids made from the title add nothing beside it; keys like WEB-12 do. */
function slugOf(title: string, id: string) {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").startsWith(id);
}

export function Pins({ project, pins, thin: thinAtFirst }: { project: string; pins: Card[]; thin: boolean }) {
  const path = usePathname();
  const [thin, setThin] = useState(thinAtFirst);
  if (!pins.length) return null;
  const toggle = () => {
    setThin(!thin);
    document.cookie = `${PINS_COOKIE}=${thin ? "full" : "thin"}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  };
  return (
    <aside className={`pins ${thin ? "thin" : "full"}`} aria-label="Pinned">
      <div className="pins-head">
        <span className="label">Pinned</span>
        <button type="button" className="fold" onClick={toggle} aria-label={thin ? "show pinned cards" : "collapse pinned"}
                data-tip={thin ? "show cards" : "collapse"}>{thin ? "»" : "«"}</button>
      </div>
      {pins.map((c) => {
        const href = `/p/${project}/i/${c.id}`;
        const here = path === href;
        return (
          <div key={c.uid} className={`pin s-${c.status}`}>
            <BoardCard c={c} project={project} who={c.developer ?? (c.status === "requested" ? c.creator : null)} led current={here} />
            <Link href={href} className="tile" aria-current={here ? "page" : undefined}>
              <span className="mark">{initials(c.title)}</span>
              <span className="name">{!slugOf(c.title, c.id) && <span className="pid">{c.id}</span>}{c.title}</span>
            </Link>
            <button type="button" className="unpin" aria-label={`unpin ${c.id}`} data-tip="unpin"
                    onClick={() => void pin({ project, itemUid: c.uid, on: false })}>×</button>
          </div>
        );
      })}
    </aside>
  );
}
