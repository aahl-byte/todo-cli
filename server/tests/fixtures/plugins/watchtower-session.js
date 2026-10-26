// watchtower-session.js
export async function run({ item, settings, watchtower, attach, wait }) {
  const name = `todo: ${item.id}`;
  const { sessions = [] } = await watchtower.get("/api/roster");

  const live = sessions.find((s) => s.name === name && s.state === "active" && s.managed);
  if (live) return send(live.id, settings.resumePrompt ?? settings.prompt, "sent to");

  const stopped = settings.resumePrompt && sessions
    .filter((s) => s.name === name && s.state === "stopped")
    .sort((a, b) => b.lastActivity - a.lastActivity)[0];
  if (stopped) {
    try {
      await watchtower.post(`/api/sessions/${stopped.id}/resume`);
      await idle(stopped.id);
      return send(stopped.id, settings.resumePrompt, "resumed");
    } catch (e) {
      if (e.waiting) throw e;
    }
  }

  const started = await watchtower.post("/api/sessions", { dir: settings.dir, name, model: settings.model });
  await idle(started.id);
  return send(started.id, settings.prompt, "started");

  async function idle(id) {
    await wait.until(async () => {
      const s = await watchtower.get(`/api/sessions/${id}`);
      if (s.status === "waiting") throw Object.assign(new Error(`session is waiting on ${s.waitingFor}`), { waiting: true });
      return s.state !== "stopped" && s.status === "idle";
    }, { every: "2s", timeout: "3m" });
  }

  async function send(id, text, verb) {
    await wait.retry(() => watchtower.post(`/api/sessions/${id}/message`, { text, from: "todo" }),
                     { when: (e) => e.message.includes("input isn't visible"), attempts: 6, every: "1s" });
    attach.log(`${verb} Watchtower session ${name}: ${id}`);
  }
}
