import type { ReactNode } from "react";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import type { Viewport } from "next";
import { WakeLock } from "@/components/WakeLock";
import { APP_NAME, withBase } from "@/lib/base";
import "./globals.css";

const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });
const disp = Space_Grotesk({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-disp", display: "swap" });

export const metadata = {
  title: "todo",
  description: "Team todo dashboard",
  icons: { icon: withBase("/icon.svg"), apple: withBase("/apple-touch-icon.png") },
  appleWebApp: { capable: true, title: APP_NAME, statusBarStyle: "black" },
};

export const viewport: Viewport = { themeColor: "#11151b" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${mono.variable} ${disp.variable}`}>
      <body>
        <WakeLock />
        {children}
      </body>
    </html>
  );
}
