"use client";
// Keep the screen awake while the app is open. The browser drops the lock
// whenever the tab is hidden, so take it again each time it comes back.
import { useEffect } from "react";

export function WakeLock() {
  useEffect(() => {
    if (!("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    const acquire = async () => {
      if (document.hidden || (lock && !lock.released)) return;
      try {
        lock = await navigator.wakeLock.request("screen");
      } catch {}
    };
    void acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      document.removeEventListener("visibilitychange", acquire);
      void lock?.release();
    };
  }, []);
  return null;
}
