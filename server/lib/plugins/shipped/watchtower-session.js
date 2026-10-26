// watchtower-session: the item's own session, named `todo: <id>`, gets the
// prompt. A live one is sent it; with a resume prompt, the newest stopped one
// is resumed first; otherwise a new one starts, with a short prompt inline.
const INITIAL_PROMPT_MAX = 200;
const IDLE_WAIT = "90s";
const IDLE_POLL = "2s";
/** Waits between sends while Watchtower can't see the session's input box yet. */
const INPUT_RETRY = ["1s", "2s", "3s", "3s", "3s", "3s"];

export async function run({ item, settings, watchtower, attach, wait, dryRun, instance, trigger }) {
  const name = `todo: ${item.id}`;
  const link = (id) => (settings.link ? `${String(settings.link).replace(/\/+$/, "")}/?session=${encodeURIComponent(id)}` : id);
  // The dev-log line an Action wrote: `action <name> (<trigger>): <what happened>`.
  const done = (summary) => attach.log({ text: `action ${instance.name} (${trigger}): ${summary}`, key: `watchtower:${Date.now()}` });

  const roster = await watchtower.get("/api/roster");
  const sessions = (roster && roster.sessions) || [];

  const live = sessions.find((s) => s && s.name === name && s.state === "active" && s.managed);
  if (live) {
    const sent = await send(live.id, settings.resumePrompt || settings.prompt);
    if (dryRun) return;
    return done(`sent to Watchtower session ${name} (${(sent && sent.delivered) || "sent"}): ${link(live.id)}`);
  }

  if (settings.resumePrompt) {
    const prev = sessions.filter((s) => s && s.name === name && s.state === "stopped")
      .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))[0];
    if (prev) {
      let back = true;
      try {
        await watchtower.post(`/api/sessions/${prev.id}/resume`);
        if (dryRun) return;
        await idle(prev.id);
      } catch (e) {
        if (e.waiting) throw e;
        back = false;
      }
      if (back) {
        const sent = await send(prev.id, settings.resumePrompt);
        return done(`resumed Watchtower session ${name} (${(sent && sent.delivered) || "sent"}): ${link(prev.id)}`);
      }
    }
  }

  const inline = settings.prompt.length <= INITIAL_PROMPT_MAX && !/[\u0000-\u001f]/.test(settings.prompt);
  const started = await watchtower.post("/api/sessions", {
    dir: settings.dir, name, ...(settings.model ? { model: settings.model } : {}), ...(inline ? { initialPrompt: settings.prompt } : {}),
  });
  if (dryRun) return;
  if (!inline) {
    await idle(started.id);
    await send(started.id, settings.prompt);
  }
  return done(`started Watchtower session ${name} in ${settings.dir}: ${link(started.id)}`);

  async function idle(id) {
    try {
      await wait.until(async () => {
        const s = (await watchtower.get(`/api/sessions/${id}`)) || {};
        if (s.state !== "stopped" && s.status === "idle") return true;
        if (s.status === "waiting") {
          throw Object.assign(new Error(`session ${id} is waiting on ${s.waitingFor || "a person"}: ${link(id)}`), { waiting: true });
        }
        return false;
      }, { every: IDLE_POLL, timeout: IDLE_WAIT });
    } catch (e) {
      if (e.waiting || !String(e.message).startsWith("wait.until gave up")) throw e;
      throw new Error(`session ${id} never went idle: ${link(id)}`);
    }
  }

  function send(id, text) {
    return wait.retry(() => watchtower.post(`/api/sessions/${id}/message`, { text, from: "todo" }),
                      { when: (e) => String(e.message).includes("input isn't visible"), attempts: INPUT_RETRY.length + 1, every: INPUT_RETRY });
  }
}
