# Environments and derived deploy checks

**Decision asked for:** how an environment is defined, and whether reaching
production moves an item to `deployed` on its own. The questions at the end
block the build; everything above them is the proposal.

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

## Questions

1. **Environments:** what are yours, and which branch does each deploy from?
   Is it one repo per project, or can an item's PRs span repos with different
   branch names?
2. **Reaching production:** should it move the item to `deployed`, or only
   show the chip and leave the move to the deployer?
3. **Is branch containment the right signal?** If a deploy can lag its branch
   (a manual promote, a failed pipeline), the honest signal is a deploy event
   from CI or the host instead, posted to the server.
4. **Migrations and env vars:** which path globs hold your migrations, and which
   file lists env vars (`.env.example`)? Or should these be per-project
   settings with no defaults?
