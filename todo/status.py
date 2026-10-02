"""The status lifecycle — the single source of truth for valid statuses, the
shortcut subcommands that set them, and the terminal colors that make them
legible at a glance.

Keep this in sync with TODO.yaml's schema header and the web TodoDrawer's
STATUSES ring (manager/sources/todos.ts in the claude-tmux-manager repo) so the
drawer colors and the click-to-cycle ring stay meaningful.

Lifecycle:
    todo → in-triage (planning) → in-progress (developing) → done
`review` parks an item awaiting user review, `blocked` an item that can't
proceed, `deferred` an item pushed off the main path, and `cancelled` one that
will never be done.

Team lifecycle (docs/plans/2026-10-02-team-store-design.md):
    requested → in-triage → todo → in-progress ⇄ review → ready-for-qa → in-qa
    → ready-to-deploy → deployed
QA rejection returns an item to in-progress.
"""

# Order is the click-to-cycle ring order. `review`/`blocked` are special states
# an item enters on demand rather than flowing through, but they're first-class
# valid statuses everywhere.
STATUSES = ["requested", "todo", "in-triage", "in-progress", "review", "ready-for-qa",
            "in-qa", "ready-to-deploy", "deployed", "blocked", "deferred", "cancelled",
            "done"]

# Finished with, one way or the other: hidden from the everyday `todo list` and
# swept up by `todo archive`.
TERMINAL = ["done", "cancelled", "deployed"]

# Finished successfully: stamp `completed`, and `todo archive` files them away.
COMPLETE = ["done", "deployed"]

# The "active" set — items actually in motion right now. Drives the default of
# the cross-project view (`todo list -g`): what's on my plate across every repo,
# excluding not-yet-started (todo/in-triage), parked (deferred), and done.
ACTIVE = ["in-progress", "blocked", "review", "ready-for-qa", "in-qa"]

# Shortcut subcommand → status it sets.
SHORTCUTS = {
    "request": "requested",
    "triage": "in-triage",
    "start": "in-progress",
    "review": "review",
    "block": "blocked",
    "defer": "deferred",
    "cancel": "cancelled",
    "done": "done",
    "reopen": "todo",
    "ready-qa": "ready-for-qa",
    "qa": "in-qa",
    "approve": "ready-to-deploy",
    "deploy": "deployed",
}

# Human-friendly help for each shortcut, shown in `todo --help`.
SHORTCUT_HELP = {
    "request": "→ requested (submitted, not yet triaged)",
    "triage": "→ in-triage (planning)",
    "start": "→ in-progress (developing)",
    "review": "→ review (awaiting user review)",
    "block": "→ blocked (can't proceed)",
    "defer": "→ deferred",
    "cancel": "→ cancelled (never going to happen)",
    "done": "→ done (stamps completed)",
    "reopen": "→ todo",
    "ready-qa": "→ ready-for-qa (hand to QA)",
    "qa": "→ in-qa (QA picks it up)",
    "approve": "→ ready-to-deploy (QA approved)",
    "deploy": "→ deployed (blocked by pending pre-deploy checks)",
}

# ANSI foreground colors per status — purple for review, red for blocked, to
# mirror the web drawer's palette. Used only when stdout is a TTY.
_COLORS = {
    "requested": "34",     # blue/slate
    "todo": "37",          # white/grey
    "in-triage": "33",     # yellow
    "in-progress": "36",   # cyan
    "review": "35",        # purple/magenta
    "blocked": "31",       # red
    "deferred": "90",      # bright black (dim)
    "cancelled": "2;31",   # dim red
    "done": "32",          # green
    "ready-for-qa": "38;5;208",     # orange
    "in-qa": "38;5;214",            # amber
    "ready-to-deploy": "38;5;30",   # teal
    "deployed": "1;32",             # bold green
}


def colorize(status: str, text: str, enabled: bool) -> str:
    """Wrap `text` in the ANSI color for `status` when `enabled`, else return it
    unchanged (so piped/redirected output stays clean)."""
    code = _COLORS.get(status)
    if not enabled or code is None:
        return text
    return f"\033[{code}m{text}\033[0m"


# Precedence for the DERIVED parent scalar (calc-status), highest first.
# `done` (all live tasks done) and the all-parked cases are handled separately;
# this list ranks the in-flight states.
CALC_PRECEDENCE = ["in-progress", "blocked", "in-qa", "ready-for-qa", "review",
                   "ready-to-deploy", "in-triage", "requested", "todo"]

# Parked children — excluded from the completion math, since work nobody intends
# to do shouldn't hold the parent short of `done`.
PARKED = ["deferred", "cancelled"]


def derive_calc_status(task_statuses):
    """Roll a list of child task statuses up to one scalar, or None when there
    are no tasks. `deferred`/`cancelled` children are excluded from the
    completion math: an item is `done` only when every live task is done (or
`deployed` when every live task is deployed). With
    no live tasks left it's `cancelled` if every task was cancelled, else
    `deferred` (something is still parked and may come back). Otherwise it's the
    highest-ranked state present (see CALC_PRECEDENCE)."""
    if not task_statuses:
        return None
    live = [s for s in task_statuses if s not in PARKED]
    if not live:
        return "cancelled" if all(s == "cancelled" for s in task_statuses) else "deferred"
    if all(s == "deployed" for s in live):
        return "deployed"
    if all(s in COMPLETE for s in live):
        return "done"
    for s in CALC_PRECEDENCE:
        if s in live:
            return s
    return "todo"
