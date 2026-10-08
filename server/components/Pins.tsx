"use client";
// The pinned bar: a thin strip down the left edge, one tile per pinned item,
// that widens on hover to show titles.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { pin } from "@/app/item-actions";
import type { Pin } from "@/lib/pins";

function initials(title: string) {
  const words = title.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "·";
}

/** Ids made from the title add nothing beside it; keys like WEB-12 do. */
function slugOf(title: string, id: string) {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").startsWith(id);
}

export function Pins({ project, pins }: { project: string; pins: Pin[] }) {
  const path = usePathname();
  if (!pins.length) return null;
  return (
    <aside className="pins" aria-label="Pinned">
      {pins.map((p) => {
        const href = `/p/${project}/i/${p.id}`;
        return (
          <div key={p.uid} className={`pin s-${p.status}`} data-uid={p.uid}>
            <Link href={href} aria-current={path === href ? "page" : undefined}>
              <span className="mark">{initials(p.title)}</span>
              <span className="name">{!slugOf(p.title, p.id) && <span className="pid">{p.id}</span>}{p.title}</span>
            </Link>
            <button type="button" className="unpin" aria-label={`unpin ${p.id}`}
                    onClick={() => void pin({ project, itemUid: p.uid, on: false })}>×</button>
          </div>
        );
      })}
    </aside>
  );
}
