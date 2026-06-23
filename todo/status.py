"""The status lifecycle — the single source of truth for valid statuses, the
shortcut subcommands that set them, and the terminal colors that make them
legible at a glance.

Keep this in sync with TODO.yaml's schema header and the web TodoDrawer's
STATUSES ring (manager/sources/todos.ts in the claude-tmux-manager repo) so the
drawer colors and the click-to-cycle ring stay meaningful.

Lifecycle:
    todo → in-triage (planning) → in-progress (developing) → done
`review` parks an item awaiting user review, `blocked` an item that can't
proceed, and `deferred` an item pushed off the main path.
"""

# Order is the click-to-cycle ring order. `review`/`blocked` are special states
# an item enters on demand rather than flowing through, but they're first-class
# valid statuses everywhere.
STATUSES = ["todo", "in-triage", "in-progress", "review", "blocked", "deferred", "done"]

# Shortcut subcommand → status it sets.
SHORTCUTS = {
    "triage": "in-triage",
    "start": "in-progress",
    "review": "review",
    "block": "blocked",
    "defer": "deferred",
    "done": "done",
    "reopen": "todo",
}

# Human-friendly help for each shortcut, shown in `todo --help`.
SHORTCUT_HELP = {
    "triage": "→ in-triage (planning)",
    "start": "→ in-progress (developing)",
    "review": "→ review (awaiting user review)",
    "block": "→ blocked (can't proceed)",
    "defer": "→ deferred",
    "done": "→ done (stamps completed)",
    "reopen": "→ todo",
}

# ANSI foreground colors per status — purple for review, red for blocked, to
# mirror the web drawer's palette. Used only when stdout is a TTY.
_COLORS = {
    "todo": "37",          # white/grey
    "in-triage": "33",     # yellow
    "in-progress": "36",   # cyan
    "review": "35",        # purple/magenta
    "blocked": "31",       # red
    "deferred": "90",      # bright black (dim)
    "done": "32",          # green
}


def colorize(status: str, text: str, enabled: bool) -> str:
    """Wrap `text` in the ANSI color for `status` when `enabled`, else return it
    unchanged (so piped/redirected output stays clean)."""
    code = _COLORS.get(status)
    if not enabled or code is None:
        return text
    return f"\033[{code}m{text}\033[0m"
