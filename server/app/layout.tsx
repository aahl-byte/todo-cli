import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "todo", description: "Team todo dashboard" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
