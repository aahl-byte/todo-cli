"""The status lifecycle — the single source of truth for valid statuses and the
shortcut subcommands that set them.

Keep this in sync with TODO.yaml's schema header and the web TodoDrawer's
STATUSES ring (manager/sources/todos.ts in the claude-tmux-manager repo) so the
drawer colors and the click-to-cycle ring stay meaningful.

Lifecycle:
    todo → in-triage (planning) → in-progress (developing) → done
`deferred` parks an item off the main path.
"""

STATUSES = ["todo", "in-triage", "in-progress", "deferred", "done"]

# Shortcut subcommand → status it sets.
SHORTCUTS = {
    "triage": "in-triage",
    "start": "in-progress",
    "done": "done",
    "defer": "deferred",
    "reopen": "todo",
}

# Human-friendly help for each shortcut, shown in `todo --help`.
SHORTCUT_HELP = {
    "triage": "→ in-triage (planning)",
    "start": "→ in-progress (developing)",
    "done": "→ done (stamps completed)",
    "defer": "→ deferred",
    "reopen": "→ todo",
}
