import type { ReactNode } from "react";
import { withBase } from "@/lib/base";

/** The dashboard installs as one app; each wall display installs as its own. */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <link rel="manifest" href={withBase("/manifest.webmanifest")} crossOrigin="use-credentials" />
      {children}
    </>
  );
}
