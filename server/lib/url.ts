/** Only http(s) URLs become links; anything else renders as text. */
export function safeUrl(url: unknown): string | null {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
}
