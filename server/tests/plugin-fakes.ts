// A local HTTP server that answers from recorded responses and keeps what it was sent.
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

/** One recorded answer; a route answers its list in order and then repeats the last one. */
export interface Recorded { method: string; path: string; status?: number; body?: unknown; text?: string; delayMs?: number }
export interface Received { method: string; path: string; headers: IncomingHttpHeaders; body: unknown }

export interface FakeServer { url: string; received: Received[]; close(): Promise<void> }

export async function fakeServer(responses: Recorded[]): Promise<FakeServer> {
  const routes = new Map<string, Recorded[]>();
  for (const r of responses) {
    const k = `${r.method.toUpperCase()} ${r.path}`;
    routes.set(k, [...(routes.get(k) ?? []), r]);
  }
  const used = new Map<string, number>();
  const received: Received[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body: unknown = raw || undefined;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { /* keep the text */ }
    received.push({ method: req.method!, path: req.url!, headers: req.headers, body });
    const k = `${req.method} ${req.url}`;
    const list = routes.get(k);
    if (!list) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ message: `no recorded response for ${k}` }));
      return;
    }
    const n = used.get(k) ?? 0;
    used.set(k, n + 1);
    const r = list[Math.min(n, list.length - 1)];
    if (r.delayMs) await new Promise((done) => setTimeout(done, r.delayMs));
    const text = r.text ?? (r.body === undefined ? "" : JSON.stringify(r.body));
    res.writeHead(r.status ?? 200, { "content-type": "application/json" }).end(text);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}
