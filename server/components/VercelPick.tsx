"use client";
// vercel-preview's team and project, picked from what the project's Vercel
// token can see instead of typed as ids.
import { useState } from "react";
import { withBase } from "@/lib/base";
import type { Choice, VercelChoices } from "@/lib/plugins/vercel";

async function load(projectKey: string, repo: string, team: string | null): Promise<VercelChoices> {
  const q = new URLSearchParams({ repo, ...(team ? { team } : {}) });
  const res = await fetch(withBase(`/api/projects/${encodeURIComponent(projectKey)}/plugins/vercel?${q}`)).catch(() => null);
  if (!res?.ok) return { teams: [], projects: [], error: res ? `the server answered ${res.status}` : "the server couldn't be reached" };
  return res.json();
}

export function VercelPick({ projectKey, repo, team: start, onPick }: {
  projectKey: string; repo: string; team: string; onPick: (team: string, project: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [teams, setTeams] = useState<Choice[] | null>(null);
  const [projects, setProjects] = useState<Choice[] | null>(null);
  const [team, setTeam] = useState(start);
  const [project, setProject] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pickTeam = async (id: string) => {
    setTeam(id);
    setProject("");
    setProjects(null);
    if (!id) return;
    const got = await load(projectKey, repo, id);
    setProjects(got.projects);
    setError(got.error);
  };
  const show = async () => {
    setOpen(true);
    const got = await load(projectKey, repo, null);
    setTeams(got.teams);
    setError(got.error);
    if (start && got.teams.some((t) => t.id === start)) await pickTeam(start);
  };
  if (!open) return <button type="button" className="link-btn vercel-pick" onClick={show}>Pick the team and project from Vercel ›</button>;
  return (
    <div className="rule-row vercel-pick">
      <select aria-label="Vercel team" value={team} disabled={!teams?.length} onChange={(e) => pickTeam(e.target.value)}>
        <option value="">{teams ? (teams.length ? "team…" : "no team") : "loading…"}</option>
        {teams?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      <select aria-label="Vercel project" value={project} disabled={!projects?.length} onChange={(e) => setProject(e.target.value)}>
        <option value="">{projects ? (projects.length ? "project…" : "no project") : "project…"}</option>
        {projects?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <button type="button" className="btn" disabled={!team || !project} onClick={() => { onPick(team, project); setOpen(false); }}>Use these</button>
      <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
      {error && <span className="hot">{error}.</span>}
    </div>
  );
}
