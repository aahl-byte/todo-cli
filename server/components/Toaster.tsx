"use client";
// Rejections outlive the form that caused them: a refresh can remove that form
// (the item moved on), so ActionForm also raises them here, in the top bar.
import { useEffect, useState } from "react";

export const NOTICE = "todo:notice";

export interface ToastAction { label: string; run: () => void }

export function notify(message: string, action?: ToastAction) {
  window.dispatchEvent(new CustomEvent(NOTICE, { detail: { message, action } }));
}

export function Toaster() {
  const [messages, setMessages] = useState<{ id: number; text: string; action?: ToastAction }[]>([]);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail ?? {};
      const text = String(typeof d === "string" ? d : d.message ?? "");
      setMessages((m) => [...m.slice(-2), { id: Date.now() + Math.random(), text, action: d.action }]);
    };
    window.addEventListener(NOTICE, on);
    return () => window.removeEventListener(NOTICE, on);
  }, []);
  if (!messages.length) return null;
  return (
    <div className="toasts" role="alert">
      {messages.map((m) => (
        <div key={m.id} className="toast banner">
          <span>{m.text}</span>
          {m.action && (
            <button type="button" className="btn" onClick={() => { m.action!.run(); setMessages((all) => all.filter((x) => x.id !== m.id)); }}>
              {m.action.label}
            </button>
          )}
          <button aria-label="dismiss" onClick={() => setMessages((all) => all.filter((x) => x.id !== m.id))}>✕</button>
        </div>
      ))}
    </div>
  );
}
