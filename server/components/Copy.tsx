"use client";
import { useState, type ReactNode } from "react";

/** Copy text; navigator.clipboard exists only on https and localhost, so plain http falls back to a hidden textarea. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.appendChild(el);
  el.select();
  try {
    return document.execCommand("copy");
  } finally {
    el.remove();
  }
}

const COPIED_MS = 1500;

export function CopyButton({ text, tip = "copy", className, children }: { text: string; tip?: string; className?: string; children: ReactNode }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    setState((await copyText(text)) ? "copied" : "failed");
    setTimeout(() => setState("idle"), COPIED_MS);
  };
  return (
    <button type="button" className={`${className ?? ""} ${state === "copied" ? "copied" : ""}`}
            data-tip={state === "copied" ? "copied" : state === "failed" ? "couldn't copy" : tip} onClick={() => void copy()}>
      {children}{state === "copied" && <span className="copied-mark" aria-label="copied"> ✓</span>}
    </button>
  );
}
