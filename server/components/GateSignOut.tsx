"use client";
// Ends the sign-in proxy's session once a display is set up, so the device
// keeps only its read-only key. Without a proxy in front the call just fails.
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

export function GateSignOut() {
  const router = useRouter();
  const path = usePathname();
  useEffect(() => {
    fetch("/_gate/revoke", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" })
      .catch(() => {})
      .finally(() => router.replace(path));
  }, [router, path]);
  return null;
}
