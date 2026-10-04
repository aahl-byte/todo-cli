import Link from "next/link";
import { logoutAction } from "@/app/actions";
import type { Project } from "@/lib/views";
import { Live } from "./Live";
import { Nav } from "./Nav";
import { Toaster } from "./Toaster";
import { Tooltips } from "./ui";

export function TopBar({ handle, project, all }: { handle: string; project?: Project; all: Project[] }) {
  return (
    <header className="topbar">
      <Link href="/" className="brand">todo</Link>
      {all.length > 1 ? (
        <details className="switcher">
          <summary className="label">{project ? project.name || project.key : "projects"}<span className="caret">▾</span></summary>
          <div className="menu">{all.map((p) => <Link key={p.key} href={`/p/${p.key}`}>{p.name || p.key}</Link>)}</div>
        </details>
      ) : project && <span className="label proj">{project.name || project.key}</span>}
      {project && <Nav projectKey={project.key} deployStep={project.deploy_step} />}
      <span className="spacer" />
      {project && <Link href={`/p/${project.key}/new`} className="add">+ request</Link>}
      <Live project={project?.key} cursor={project?.seq} />
      <details className="switcher user">
        <summary className="label">{handle}<span className="caret">▾</span></summary>
        <div className="menu"><form action={logoutAction}><button className="add">sign out</button></form></div>
      </details>
      <Toaster />
      <Tooltips />
    </header>
  );
}
