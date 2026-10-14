"use client";
// Re-renders the server page on a timer and shows when it last did, in the
// viewer's time zone. A failed refresh keeps what's on screen.
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function AutoRefresh({ everyMs, at }: { everyMs: number; at: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(id);
  }, [router, everyMs]);
  const time = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return <span className="updated" suppressHydrationWarning>updated {time}</span>;
}
