import crypto from "node:crypto";
import type { Db } from "./db";
import { hashToken, newToken } from "./auth";

export const LOGIN_TTL_SECONDS = 600;
export const POLL_INTERVAL_SECONDS = 3;
export const MAX_PENDING_LOGINS = 25;

const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";

export interface PendingLogin { user_code: string; label: string; created: string; handle: string | null }
export interface ApiToken { id: number; label: string; created: string; last_used: string | null }

export type PollResult =
  | { status: "pending" | "slow_down" | "expired" }
  | { status: "approved"; token: string; handle: string };

function userCode(): string {
  const pick = () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return Array.from({ length: 8 }, pick).join("").replace(/^(.{4})/, "$1-");
}

export const cleanCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(.{4})(.+)$/, "$1-$2");

const cleanLabel = (label: unknown) =>
  String(label ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80) || "command line";

/** Open a login request for a CLI; null when too many are already waiting. */
export async function startLogin(d: Db, label: unknown) {
  await d.query("delete from device_logins where expires < now()");
  const [{ n }] = await d.query("select count(*)::int as n from device_logins");
  if (n >= MAX_PENDING_LOGINS) return null;
  const device_code = newToken();
  const user_code = userCode();
  await d.query(
    `insert into device_logins (device_hash, user_code, label, expires)
     values ($1, $2, $3, now() + make_interval(secs => $4))`,
    [hashToken(device_code), user_code, cleanLabel(label), LOGIN_TTL_SECONDS]);
  return { device_code, user_code, expires_in: LOGIN_TTL_SECONDS, interval: POLL_INTERVAL_SECONDS };
}

export async function pendingLogin(d: Db, code: string): Promise<PendingLogin | null> {
  const [row] = await d.query(
    "select user_code, label, created, handle from device_logins where user_code = $1 and expires > now()", [cleanCode(code)]);
  return (row as PendingLogin) ?? null;
}

/** Let the CLI waiting on this code collect a token for `handle`. */
export async function approveLogin(d: Db, code: string, handle: string): Promise<boolean> {
  const rows = await d.query(
    "update device_logins set handle = $2 where user_code = $1 and expires > now() and handle is null returning user_code",
    [cleanCode(code), handle]);
  return rows.length > 0;
}

export async function denyLogin(d: Db, code: string): Promise<void> {
  await d.query("delete from device_logins where user_code = $1 and handle is null", [cleanCode(code)]);
}

/** The CLI's poll. An approved login hands over its token once and is deleted. */
export async function pollLogin(d: Db, deviceCode: string): Promise<PollResult> {
  const hash = hashToken(deviceCode);
  const [row] = await d.query(
    "select handle, label, expires > now() as live, last_poll > now() - make_interval(secs => $2) as fast from device_logins where device_hash = $1",
    [hash, POLL_INTERVAL_SECONDS - 1]);
  if (!row || !row.live) return { status: "expired" };
  if (row.fast) return { status: "slow_down" };
  if (!row.handle) {
    await d.query("update device_logins set last_poll = now() where device_hash = $1", [hash]);
    return { status: "pending" };
  }
  const taken = await d.query("delete from device_logins where device_hash = $1 and handle is not null returning handle, label", [hash]);
  if (!taken.length) return { status: "expired" };
  const token = await addApiToken(d, taken[0].handle, taken[0].label);
  return { status: "approved", token, handle: taken[0].handle };
}

export async function addApiToken(d: Db, handle: string, label: string, token: string = newToken()): Promise<string> {
  await d.query("insert into api_tokens (token_hash, handle, label) values ($1, $2, $3)", [hashToken(token), handle, label]);
  return token;
}

export async function apiTokens(d: Db, handle: string): Promise<ApiToken[]> {
  return d.query("select id, label, created, last_used from api_tokens where handle = $1 order by created desc", [handle]) as any;
}

export async function revokeApiToken(d: Db, handle: string, id: number): Promise<boolean> {
  return (await d.query("delete from api_tokens where id = $1 and handle = $2 returning id", [id, handle])).length > 0;
}
