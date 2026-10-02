"use client";
// A form bound to a server action. It freezes the entity versions when the user
// starts interacting, so a live refresh can't swap the base under an open
// composer; a rejected write shows a banner and keeps the draft.
import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import type { ActionState } from "@/app/actions";

type Action = (prev: ActionState, fd: FormData) => Promise<ActionState>;

export function ActionForm({ action, fields, versions, children, className, resetOnOk = true, confirmLabel }: {
  action: Action;
  fields: Record<string, string | number | null | undefined>;
  versions?: Record<string, number>;
  children: ReactNode;
  className?: string;
  resetOnOk?: boolean;
  confirmLabel?: string;
}) {
  const [state, formAction, pending] = useActionState(action, { ok: true });
  const [frozen, setFrozen] = useState<Record<string, number> | null>(null);
  const ref = useRef<HTMLFormElement>(null);
  const freeze = () => {
    if (!frozen && versions) setFrozen(versions);
  };
  useEffect(() => {
    if (state.ok && state.at) {
      setFrozen(null);
      if (resetOnOk) ref.current?.reset();
    }
  }, [state, resetOnOk]);
  return (
    <form ref={ref} action={formAction} className={className} onFocusCapture={freeze} onInputCapture={freeze}
          onSubmit={(e) => {
            if (confirmLabel && !window.confirm(confirmLabel)) e.preventDefault();
          }}>
      {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v ?? ""} />)}
      {versions && <input type="hidden" name="versions" value={JSON.stringify(frozen ?? versions)} />}
      <fieldset disabled={pending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>{children}</fieldset>
      {!state.ok && state.message && <div className="banner" role="alert">{state.message}</div>}
      {state.ok && state.message && <div className="banner ok">{state.message}</div>}
    </form>
  );
}
