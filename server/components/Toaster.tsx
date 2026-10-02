"use client";
// Rejections outlive the form that caused them: a refresh can remove that form
// (the item moved on), so ActionForm also raises them here, in the top bar.
import { useEffect, useState } from "react";

export const NOTICE = "todo:notice";

export function notify(message: string) {
  window.dispatchEvent(new CustomEvent(NOTICE, { detail: message }));
}

export function Toaster() {
  const [messages, setMessages] = useState<{ id: number; text: string }[]>([]);
  useEffect(() => {
    const on = (e: Event) => {
      const text = String((e as CustomEvent).detail ?? "");
      setMessages((m) => [...m.slice(-2), { id: Date.now() + Math.random(), text }]);
    };
    window.addEventListener(NOTICE, on);
    return () => window.removeEventListener(NOTICE, on);
  }, []);
  if (!messages.length) return null;
  return (
    <div className="toasts" role="alert">
      {messages.map((m) => (
        <div key={m.id} className="banner">
          {m.text} <button className="link" onClick={() => setMessages((all) => all.filter((x) => x.id !== m.id))}>dismiss</button>
        </div>
      ))}
    </div>
  );
}
