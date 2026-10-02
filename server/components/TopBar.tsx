import Link from "next/link";
import { logoutAction } from "@/app/actions";
import type { Project } from "@/lib/views";
import { Live } from "./Live";
import { Toaster } from "./Toaster";

export function TopBar({ handle, project, all }: { handle: string; project?: Project; all: Project[] }) {
  return (
    <header className="topbar">
      <Link href="/" className="brand">todo</Link>
      <details style={{ position: "relative" }}>
        <summary>{project ? project.name || project.key : "projects"}</summary>
        <div className="panel" style={{ position: "absolute", zIndex: 10, minWidth: 180 }}>
          {all.map((p) => <div key={p.key}><Link href={`/p/${p.key}`}>{p.name || p.key}</Link></div>)}
        </div>
      </details>
      {project && (
        <nav aria-label="project" className="wide-nav">
          <Link href={`/p/${project.key}`}>Board</Link>
          <Link href={`/p/${project.key}/qa`}>QA</Link>
          {project.deploy_step && <Link href={`/p/${project.key}/deploy`}>Deploy</Link>}
          <Link href={`/p/${project.key}/new`} className="btn primary">New request</Link>
        </nav>
      )}
      {project && (
        <details className="nav-menu">
          <summary aria-label="menu">Menu</summary>
          <nav aria-label="project menu" className="panel">
          <Link href={`/p/${project.key}`}>Board</Link>
          <Link href={`/p/${project.key}/qa`}>QA</Link>
          {project.deploy_step && <Link href={`/p/${project.key}/deploy`}>Deploy</Link>}
          <Link href={`/p/${project.key}/new`} className="btn primary">New request</Link>
          </nav>
        </details>
      )}
      <span className="spacer" />
      <Live project={project?.key} cursor={project?.seq} />
      <span className="mono">{handle}</span>
      <form action={logoutAction}><button className="link">sign out</button></form>
      <Toaster />
    </header>
  );
}
