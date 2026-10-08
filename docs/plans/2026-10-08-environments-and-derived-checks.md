# Environments and derived deploy checks

**Status:** a draft for the auto-derivation spin-off. The settled answers are
at the end; the deploy signal is still open.

## What it gives you

On the deploy page and the item rail, each item shows where its code is, one
chip per environment: `staging ✓  production ·`. Its deployment checks include
ones the server found by reading its PRs, such as a migration file or a new env
var, next to the ones people added. Preparing a `qa-approved` item becomes
reviewing that list, where today it is a hunt through PRs.

## Environments

A project lists its environments in order, each tied to the git branch it
deploys from:

```yaml
environments:
  - { name: dev,        branch: dev }
  - { name: staging,    branch: staging }
  - { name: production, branch: main }
```

An item is **in** an environment once every merged PR linked to it is
contained in that branch. GitHub's compare API answers this:
`GET /repos/{o}/{r}/compare/{branch}...{merge_commit_sha}` reports `behind` or
`identical` when the branch already holds the commit. An item with no PR links
has no environment state.

The server computes this; nobody sets it. It runs where PR statuses already
load (item page, deploy page), cached like `prStatus`, and on the Actions
cron. The status itself stays manual. The open question is whether
"in production" should move the item to `deployed`.

## Derived checks

The server reads each linked PR's file list (`GET /pulls/{n}/files`) and adds
the checks it implies:

| found in the PR | check |
|-----------------|-------|
| always, one per PR | `prereq-branch` "PR #N merged into staging", done once staging holds it |
| a file matching the project's migration globs | `db-script` with the path as payload |
| a new key in the project's env example file | `env-var` with the key as payload |

A derived check carries `source: derived` and a stable key (`pr:42`,
`file:db/0042.sql`), so the next pass updates it instead of adding a
duplicate. Deleting one records a dismissal, so it doesn't come back. Ticking
it works like any check. Checks need a small schema change for this: a `meta`
jsonb column, like notes and logs have.

Derived checks are written through `applyOps` as a bridge actor, like the Jira
bridge, so they sync to every CLI.

## Settled

- Environments are dev, staging and production, shown as D, S and P. Items
  carry them as manual markers; see the `fixes` item.
- An item's PRs can span repos, so each PR link's own repo decides where to
  look.
- Reaching production never moves the item to `deployed`. Any automatic
  trigger is set explicitly on the settings page.
- Branch containment is an unreliable deploy signal. What should mark an
  environment as reached automatically is still open.
