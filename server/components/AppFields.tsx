"use client";
// App and section inputs: suggestions from the values the project already
// uses, and any typed value is accepted. Sections narrow to the chosen app.
import { useId, useState } from "react";

export type Apps = Record<string, string[]>;

export function AppFields({ apps, app: app0 = "", section: section0 = "" }: { apps: Apps; app?: string; section?: string }) {
  const id = useId();
  const [app, setApp] = useState(app0);
  const sections = apps[app] ?? [...new Set(Object.values(apps).flat())];
  return (
    <>
      <input name="app" list={`${id}-apps`} value={app} onChange={(e) => setApp(e.target.value)} aria-label="app" placeholder="app" autoComplete="off" />
      <datalist id={`${id}-apps`}>{Object.keys(apps).map((a) => <option key={a} value={a} />)}</datalist>
      <input name="section" list={`${id}-sections`} defaultValue={section0} aria-label="section" placeholder="section" autoComplete="off" />
      <datalist id={`${id}-sections`}>{sections.map((s) => <option key={s} value={s} />)}</datalist>
    </>
  );
}
