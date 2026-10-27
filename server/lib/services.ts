// The services plugins that ship with todo call, as the Automation page's
// connection form offers them: where each one is, how it authorizes, and where
// to make its token, so a person only pastes the token. Pure, so the page and
// the server share it; the server fills in the addresses its environment knows.
import type { HttpAuth } from "./plugins/types";

export type AuthKind = "none" | "bearer" | "basic" | "header";

export interface Service {
  /** The connection's name, which the shipped plugins call it by. */
  name: string;
  label: string;
  /** The address the form starts with; empty when there's no usual one. */
  url: string;
  placeholder: string;
  auth: AuthKind;
  /** For basic auth: what its two halves are called, joined as `user:pass` for the secret. */
  user?: string;
  pass?: string;
  /** What the secret is called, for bearer or header auth. */
  secret?: string;
  /** Where to make the token. */
  tokenUrl?: string;
  /** The address is this server's, never changed here: only the token is given. */
  fixed?: boolean;
  /** What the token needs, in a line. */
  hint?: string;
}

export interface ServiceAddresses { github: string; jira: string | null; watchtower: string }

/** Every known service, with the addresses this server knows filled in. */
export function services(at: ServiceAddresses): Service[] {
  return [
    { name: "github", label: "GitHub", url: at.github, placeholder: at.github, auth: "bearer", secret: "GitHub access token", fixed: true,
      tokenUrl: "https://github.com/settings/personal-access-tokens/new",
      hint: "A fine-grained token with read access to the project's repos." },
    { name: "vercel", label: "Vercel", url: "https://api.vercel.com", placeholder: "https://api.vercel.com", auth: "bearer", secret: "Vercel API token",
      tokenUrl: "https://vercel.com/account/tokens", hint: "A token with access to the team the projects are in." },
    { name: "jira", label: "Jira", url: at.jira ?? "", placeholder: "https://your-site.atlassian.net", auth: "basic", user: "Email", pass: "API token",
      tokenUrl: "https://id.atlassian.com/manage-profile/security/api-tokens", hint: "The site URL, and the email and API token of the account that moves tickets." },
    { name: "watchtower", label: "Watchtower", url: at.watchtower, placeholder: at.watchtower, auth: "none",
      hint: "Watchtower's own address on the machine it runs on." },
    { name: "db-request", label: "db-request", url: "", placeholder: "https://db-request.example.com", auth: "none",
      hint: "The db-request service that answers GET /submissions." },
  ];
}

export const serviceLabel = (list: Service[], name: string) => list.find((s) => s.name === name)?.label ?? name;

/** An auth setting as the form's choice and header name. */
export function authKind(auth: HttpAuth | null | undefined): { kind: AuthKind; header: string } {
  if (!auth) return { kind: "none", header: "" };
  if (auth.startsWith("header:")) return { kind: "header", header: auth.slice("header:".length) };
  return { kind: auth as "bearer" | "basic", header: "" };
}

/** The form's choice as a connection's auth; undefined for none. */
export function authOf(kind: AuthKind, header: string): HttpAuth | undefined {
  if (kind === "none") return undefined;
  return kind === "header" ? `header:${header.trim()}` : kind;
}
