"use client";
// A form bound to a server action. It freezes the entity versions when the user
// starts interacting, so a live refresh can't swap the base under an open
// composer. While nobody is interacting, a refresh with new versions remounts
// the fields so they show the current values rather than the ones first
// rendered. A refused write raises a notice and keeps the draft.
import { startTransition, useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import type { ActionState } from "@/app/actions";
import { notify } from "./Toaster";

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
  const shown = JSON.stringify(versions ?? null);
  const [generation, setGeneration] = useState(0);
  const lastShown = useRef(shown);
  useEffect(() => {
    if (shown !== lastShown.current) {
      lastShown.current = shown;
      if (!frozen) setGeneration((g) => g + 1);
    }
  }, [shown, frozen]);
  const freeze = () => {
    if (!frozen && versions) setFrozen(versions);
  };
  useEffect(() => {
    if (state.ok && state.at) {
      setFrozen(null);
      if (resetOnOk) ref.current?.reset();
    }
    if (!state.ok && state.message) notify(state.message);
  }, [state, resetOnOk]);
  return (
    <form ref={ref} className={className} onFocusCapture={freeze} onInputCapture={freeze}
          onSubmit={(e) => {
            // Submitting by hand skips React's automatic reset, which would wipe
            // the draft even when the write is refused.
            e.preventDefault();
            if (confirmLabel && !window.confirm(confirmLabel)) return;
            const fd = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter);
            startTransition(() => formAction(fd));
          }}>
      {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v ?? ""} />)}
      {versions && <input type="hidden" name="versions" value={JSON.stringify(frozen ?? versions)} />}
      <fieldset key={generation} disabled={pending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>{children}</fieldset>
      {!state.ok && state.message && <div className="banner" role="alert">{state.message}</div>}
      {state.ok && state.message && <div className="banner ok">{state.message}</div>}
    </form>
  );
}
