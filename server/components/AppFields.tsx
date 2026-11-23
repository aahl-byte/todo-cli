"use client";
// App and section inputs: suggestions from the values the project already
// uses, and any typed value is accepted. Sections narrow to the chosen app.
import { useId, useState } from "react";
import { usualRepo, type RepoChoices } from "@/lib/repo-choices";

export type Apps = Record<string, string[]>;

/** With `repos`, a repo input follows the chosen app's usual repo until someone types in it. */
export function AppFields({ apps, app: app0 = "", section: section0 = "", repos }: { apps: Apps; app?: string; section?: string; repos?: RepoChoices }) {
  const id = useId();
  const [app, setApp] = useState(app0);
  const [repo, setRepo] = useState(repos ? usualRepo(repos, app0) : "");
  const [repoTyped, setRepoTyped] = useState(false);
  const sections = apps[app] ?? [...new Set(Object.values(apps).flat())];
  const chooseApp = (next: string) => {
    setApp(next);
    if (repos && !repoTyped) setRepo(usualRepo(repos, next));
  };
  return (
    <>
      <input name="app" list={`${id}-apps`} value={app} onChange={(e) => chooseApp(e.target.value)} aria-label="app" placeholder="app" autoComplete="off" />
      <datalist id={`${id}-apps`}>{Object.keys(apps).map((a) => <option key={a} value={a} />)}</datalist>
      <input name="section" list={`${id}-sections`} defaultValue={section0} aria-label="section" placeholder="section" autoComplete="off" />
      <datalist id={`${id}-sections`}>{sections.map((s) => <option key={s} value={s} />)}</datalist>
      {repos && <>
        <input name="repo" list={`${id}-repos`} value={repo} onChange={(e) => { setRepo(e.target.value); setRepoTyped(true); }}
               aria-label="repo" placeholder="repo (owner/name)" autoComplete="off" />
        <datalist id={`${id}-repos`}>{repos.repos.map((r) => <option key={r} value={r} />)}</datalist>
      </>}
    </>
  );
}
