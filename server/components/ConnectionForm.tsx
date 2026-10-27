"use client";
// One of the project's own connections, set on the Automation page: where it
// points, how it authorizes, and its token, which plugins that ship with todo
// use in every repo of the project. A known service starts filled in, so a
// person only pastes the token; a private address asks to be allowed first.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { withBase } from "@/lib/base";
import type { HostConnection } from "@/lib/plugin-views";
import { authKind, authOf, type AuthKind, type Service } from "@/lib/services";
import { Stamp } from "./ui";

const NAME = /^[A-Za-z][\w-]*$/;

interface Refusal { error: string; status: number; private?: boolean }

async function save(project: string, body: unknown): Promise<Refusal | null> {
  const res = await fetch(withBase(`/api/projects/${encodeURIComponent(project)}/plugins/connections`), {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }).catch(() => null);
  if (!res) return { error: "the server couldn't be reached", status: 0 };
  if (res.ok) return null;
  const err = await res.json().catch(() => null);
  return { error: err?.error ?? `the server answered ${res.status}`, status: res.status, private: !!err?.private };
}

/** Where an address lands, as the server's guard sees it. */
async function landing(project: string, address: string): Promise<string | null> {
  const q = new URLSearchParams({ address });
  const res = await fetch(withBase(`/api/projects/${encodeURIComponent(project)}/plugins/connections?${q}`)).catch(() => null);
  return res?.ok ? (await res.json().catch(() => null))?.address ?? null : null;
}

/** The host a link names, for "Make one at vercel.com/account/tokens". */
const shortUrl = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

export function ConnectionForm({ projectKey, name: fixedName, current, service, secretProblem, taken = [], onDone, onCancel }: {
  projectKey: string;
  /** The connection's name; null asks for one. */
  name: string | null;
  /** What's there now: the project's own, or the server's; null for nothing yet. */
  current: HostConnection | null;
  service: Service | null;
  /** Why secrets can't be stored on this server, or null when they can. */
  secretProblem: string | null;
  /** Names a new connection can't take. */
  taken?: string[];
  onDone: (name: string) => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const own = current?.source === "page" ? current : null;
  // A fixed service always authorizes its own way; anything else starts from what's there, else the service's usual.
  const start = current && !service?.fixed ? { url: current.url ?? "", ...authKind(current.auth) }
    : { url: current?.url ?? service?.url ?? "", kind: service?.auth ?? "none", header: "" };
  const [name, setName] = useState(fixedName ?? "");
  const [url, setUrl] = useState(start.url);
  const [kind, setKind] = useState<AuthKind>(start.kind);
  const [header, setHeader] = useState(start.header);
  const [secret, setSecret] = useState("");
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [allow, setAllow] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [pending, run] = useTransition();
  const fixed = !!service?.fixed;
  const trimmed = name.trim();
  const clash = !fixedName && taken.includes(trimmed);
  const badName = !fixedName && !!trimmed && !NAME.test(trimmed);
  const moved = !!own && (url.trim() !== (own.url ?? "") || authOf(kind, header) !== (own.auth ?? undefined));
  const [isPrivate, setPrivate] = useState(false);
  const asksPrivate = isPrivate || !!refused?.private || !!current?.refused;
  const value = kind === "basic" ? (user || pass ? `${user}:${pass}` : "") : secret;
  const needsSecret = kind !== "none" && (!own?.held || moved);
  const label = service?.label ?? (trimmed || "the connection");
  const unchanged = !!own && !moved && !value && !(allow && !own.privateOk);
  const missing = unchanged || !trimmed || clash || badName || (!fixed && !url.trim()) || (kind === "header" && !header.trim())
    || (needsSecret && !value) || (kind === "basic" && !!value && (!user || !pass)) || (asksPrivate && !allow && !own?.privateOk);
  const submit = () => run(async () => {
    // A private address is allowed before it's saved, so ask where it lands first.
    if (!fixed && !allow && !(own?.privateOk && !moved)) {
      const at = await landing(projectKey, url.trim());
      if (at === "link-local") {
        setRefused({ error: "that's a link-local address, where a cloud's metadata service answers, which todo never calls", status: 400 });
        return;
      }
      if (at === "private") {
        setPrivate(true);
        return;
      }
    }
    const def = fixed ? undefined : { http: { url: url.trim(), ...(kind === "none" ? {} : { auth: authOf(kind, header) }) } };
    const err = await save(projectKey, {
      name: trimmed, ...(def ? { def } : {}), ...(value ? { secret: value } : {}), base: own?.version ?? null, ...(allow ? { allowPrivate: true } : {}),
    });
    setRefused(err);
    if (!err) {
      router.refresh();
      onDone(trimmed);
    }
  });
  const remove = () => run(async () => {
    if (!own || !window.confirm(`Remove the project's ${own.name} connection and its token?`)) return;
    const err = await save(projectKey, { name: own.name, def: null, base: own.version });
    setRefused(err);
    if (!err) {
      router.refresh();
      onDone(own.name);
    }
  });
  const secretLabel = service?.secret ?? (kind === "header" ? `${header.trim() || "Header"} value` : "Token");
  const stored = own?.held && !moved ? "stored · type to replace" : "never shown again";
  return (
    <form className="conn-form" data-connection-form={fixedName ?? "new"} onSubmit={(e) => { e.preventDefault(); if (!missing) submit(); }}>
      {!fixedName && (
        <label className="field">
          <span className="field-label">Name</span>
          <input aria-label="connection name" placeholder="e.g. hooks" value={name} autoFocus onChange={(e) => { setName(e.target.value); setRefused(null); }} />
        </label>
      )}
      {fixed ? (
        <p className="hint">{service!.label} at <span className="mono">{current?.url ?? service!.url}</span></p>
      ) : (
        <label className="field conn-address">
          <span className="field-label">Address</span>
          <input aria-label={`${label} address`} placeholder={service?.placeholder ?? "https://…"} value={url}
                 onChange={(e) => { setUrl(e.target.value); setRefused(null); setAllow(false); setPrivate(false); }} />
        </label>
      )}
      {!fixed && (
        <div className="conn-auth">
          <label className="field">
            <span className="field-label">Authorizes with</span>
            <select aria-label={`${label} auth`} value={kind} onChange={(e) => setKind(e.target.value as AuthKind)}>
              <option value="none">nothing</option>
              <option value="bearer">a bearer token</option>
              <option value="basic">a user and password</option>
              <option value="header">a header</option>
            </select>
          </label>
          {kind === "header" && (
            <input aria-label="credential header" placeholder="header name, e.g. X-Api-Key" value={header} onChange={(e) => setHeader(e.target.value)} />
          )}
        </div>
      )}
      {kind !== "none" && secretProblem && <p className="hint hot">Tokens can&apos;t be saved here: {secretProblem}.</p>}
      {kind === "basic" && (
        <div className="conn-secret">
          <label className="field">
            <span className="field-label">{service?.user ?? "User"}</span>
            <input aria-label={`${label} ${(service?.user ?? "user").toLowerCase()}`} autoComplete="off" value={user} disabled={!!secretProblem}
                   placeholder={own?.held && !moved ? "stored · type to replace" : ""} onChange={(e) => setUser(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">{service?.pass ?? "Password"}</span>
            <input type="password" autoComplete="new-password" aria-label={`${label} ${(service?.pass ?? "password").toLowerCase()}`} value={pass}
                   disabled={!!secretProblem} placeholder={stored} onChange={(e) => setPass(e.target.value)} />
          </label>
        </div>
      )}
      {(kind === "bearer" || kind === "header") && (
        <label className="field conn-secret">
          <span className="field-label">{secretLabel}</span>
          <input type="password" autoComplete="new-password" aria-label={`${label} token`} value={secret} disabled={!!secretProblem}
                 placeholder={stored} onChange={(e) => setSecret(e.target.value)} />
        </label>
      )}
      {service?.tokenUrl && kind !== "none" && (
        <p className="hint">Make one at <a href={service.tokenUrl} target="_blank" rel="noreferrer">{shortUrl(service.tokenUrl)} ›</a>{service.hint ? ` ${service.hint}` : ""}</p>
      )}
      {(!service?.tokenUrl || kind === "none") && service?.hint && <p className="hint">{service.hint}</p>}
      {moved && own?.held && <p className="hint">Changing the address or how it authorizes drops the stored token, so give it again.</p>}
      {asksPrivate && !(own?.privateOk && !moved) && (
        <label className="check private-ok">
          <input type="checkbox" checked={allow} onChange={(e) => setAllow(e.target.checked)} />
          This address is on your private network: allow todo to call it
        </label>
      )}
      {own?.privateOk && !moved && (
        <p className="hint">Private address allowed by {own.privateOk.by}, <Stamp ts={own.privateOk.at} />.</p>
      )}
      <div className="save-row">
        <button type="submit" className="btn primary" disabled={pending || missing}>{pending ? "Saving…" : "Save"}</button>
        <button type="button" className="btn" disabled={pending} onClick={onCancel}>Cancel</button>
        {own && !fixed && <button type="button" className="btn danger" disabled={pending} onClick={remove}>Remove</button>}
        {own && fixed && <button type="button" className="btn danger" disabled={pending} onClick={remove}>Clear token</button>}
        {clash && <span className="hot">A connection by that name is here already.</span>}
        {badName && <span className="hot">A name starts with a letter and has only letters, digits, - and _.</span>}
        {refused?.status === 409 && (
          <span className="hot stale">Not saved: {refused.error}. <button type="button" className="link-btn" onClick={() => { router.refresh(); onCancel(); }}>Reload ›</button></span>
        )}
        {refused && refused.status !== 409 && !refused.private && <span className="hot">Not saved: {refused.error}.</span>}
        {refused?.private && !allow && <span className="hot">Not saved: {refused.error}.</span>}
      </div>
    </form>
  );
}

/** Whether a connection is ready to call: an address, and a token when it takes one. */
export const connectionReady = (c: HostConnection | null, service: Service | null) =>
  !!c && !c.refused && !c.unreadable && (c.held || (!c.auth && !service?.fixed));

/** A connection's state in a line: where it points, whose it is, and what it still needs. */
export function connectionState(c: HostConnection | null, service: Service | null): { text: string; hot: boolean } {
  if (!c) return { text: service?.auth === "none" ? "No address yet." : "Not connected yet.", hot: true };
  if (service?.fixed && !c.held) return { text: "No token yet.", hot: true };
  if (c.refused) return { text: `${c.url} is on your private network, and nobody has let todo call it there.`, hot: true };
  if (c.unreadable) return { text: "Its stored token doesn't decrypt on this server: enter it again.", hot: true };
  if (c.auth && !c.held) return { text: "No token yet.", hot: true };
  const whose = c.source === "page" ? (c.updated ? `Set by ${c.updated.by}` : "Set here") : "The server's connection";
  return { text: `${whose}${c.url ? ` · ${c.url}` : ""}${c.auth ? " · token stored" : ""}.`, hot: false };
}
