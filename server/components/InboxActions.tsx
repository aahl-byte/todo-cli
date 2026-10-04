"use client";
// Inbox actions: clear a ticket's notices, and mark everything read with undo.
import { useRouter } from "next/navigation";
import * as act from "@/app/item-actions";
import { notify } from "./Toaster";

export function ClearItem({ project, itemUid, title }: { project: string; itemUid: string; title: string }) {
  const router = useRouter();
  return (
    <button type="button" className="clear" aria-label={`clear ${title}`} data-tip="clear"
            onClick={() => void act.readItem({ project, itemUid }).then(() => router.refresh())}>✓</button>
  );
}

export function MarkAllRead({ count }: { count: number }) {
  const router = useRouter();
  const run = async () => {
    const r = await act.markAllRead();
    router.refresh();
    notify(`Marked ${r.ids.length} read.`, {
      label: "Undo",
      run: () => void act.markUnread({ ids: r.ids, readAt: r.readAt }).then(() => router.refresh()),
    });
  };
  return <button type="button" className="btn" onClick={() => void run()}>Mark all read<span className="n">{count}</span></button>;
}
