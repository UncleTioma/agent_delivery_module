# How the pipeline works

This page explains the process from the product owner's point of view. The exact instructions the conductor follows are in [`roles/deliver.md`](../.agents/delivery/roles/deliver.md); every other role has its own file in [`roles/`](../.agents/delivery/roles/).

## Actors

| Actor | What it is | What it does |
|---|---|---|
| **Product owner (you)** | A human | Describes the task, answers questions, approves at checkpoints |
| **Conductor** | Claude Code or Codex session running the `deliver` skill | Runs roles in order, validates artifacts, commits, talks to you. Never writes product code |
| **Roles** | A fresh agent process per role (subagent or CLI call) | Each reads its own prompt and the files of previous stages, writes one artifact |
| **`delivery.mjs`** | Node.js CLI | Enforces what a prompt cannot: schemas, locked tests, forbidden paths, tool checks, permissions |

Roles never share a conversation. They hand work over through files in `.work/tasks/<ID>/` (git-ignored), so every stage can be resumed and audited.

## Stages

| # | Stage | Role (default tool) | Artifact | Human checkpoint |
|---|---|---|---|---|
| 1 | Clarify | `ba` (claude) | `01-questions.md`, `02-answers.md` | **H1** if there are questions |
| 2 | Requirements | `ba` | `03-requirements.md` — acceptance criteria `AC-1…` | |
| 3 | Triage | `teamlead` (claude) | `04-triage.json` — sufficient? track? needs design? | **H1** if requirements are insufficient |
| 3a | Design | `designer` (claude) | `05a-mockup.html`, `05b-mockup.png`, `05d-design-notes.md` | **HD** approve / remarks (max 3 rounds) |
| 4 | Workspace | conductor | branch `ai/<ID>-<slug>` or a worktree | |
| 5 | Tests first | `qa_design` (antigravity) | `07-test-cases.md` + failing automated tests, locked by hash | |
| 5 | Architecture | `architect` (antigravity) | `05-adr.md` — track L or any architect trigger | **H2** on track L |
| 6 | Plan | `teamlead` | `06-plan.md` — AC → code changes and tests | **H3** for migrations, RBAC, new dependencies, data deletion |
| 7 | Loop (up to 3×) | `dev` (codex) → `review` → `qa_run` | `08-dev-log.md`, `09-review.json`, `10-qa.json` | |
| 8 | Report | `report` (claude) | `11-report.md`, `independence.json` | |
| 9 | Acceptance | you | | **H4** accept or send remarks (max 2 rework rounds) |

Stage 3a runs only when triage sets `needs_design: true` (anything the user sees: screens, dialogs, texts, visual behavior). After approval the mockup is a contract: tests take expected texts and states from it, dev implements it, review checks against it, QA compares the real screen with `05b-mockup.png`, and the report has a *mockup vs result* block. The mockup itself is never committed.

### Tracks

| Track | Meaning | Differences |
|---|---|---|
| **S** | Bug or small change, 1–3 files | No architect |
| **M** | New behavior inside an existing module | No architect unless a trigger matches |
| **L** | Anything matching `architect_triggers` (data model, auth, public API, integrations, cross-module, performance) | Architect + **H2** |
| **G** | Empty project (`detect` reports `empty: true`) | Architect picks the stack (**H2** mandatory), `bootstrap` creates a skeleton with one green test and `AGENTS.md`, then the normal flow |

### The dev ↔ review ↔ QA loop

1. `dev` implements the plan until the locked tests pass (later iterations fix only `blocker`/`major` findings and failing criteria).
2. `guard` checks the diff: no forbidden paths, locked tests unchanged. Violation → back to dev once, then stop.
3. `review` writes findings (`blocker`, `major`, `minor`, …) against requirements, plan and the project's review checklist.
4. `qa_run` runs the tests and checks every acceptance criterion; verdict as JSON.
5. No blockers and every criterion passes → report. Otherwise another iteration, up to `limits.max_iterations`; then the pipeline stops and shows you the open findings.

## Independence

The value of review and QA comes from being done by a different model than the one that wrote the code. The module therefore:

- keeps `review`, `qa_design` and `qa_run` on a different tool than `dev` whenever two or more tools are available;
- with a single tool, still runs, starts every such role as a fresh process without dev context, locks the tests and runs `guard`, and prints a **weak independence** badge with the list of mitigations in the report.

## What is automatic and what is not

| Enforced by `delivery.mjs` (code) | Followed by the conductor (prompt) |
|---|---|
| JSON schema validation of artifacts | Order of stages and when to ask you |
| Locked QA tests, forbidden paths (`guard`) | Retrying a failed role once |
| Silent-failure detection in tool logs (`check-output`) | Summarising results for you |
| Tool availability, flags, role map (`doctor`) | Keeping its own context small |
| Permission rules (`perms`) | |

## Git behavior

- One task = one branch from `base_branch` (`isolation: branch`, one task at a time) or one worktree (`isolation: worktree`).
- Commits are made by the conductor after `qa_design`, after each `dev` iteration and after `bootstrap`. Roles on Codex and in the Antigravity sandbox cannot write to `.git/` and never commit.
- If a sandboxed role cannot write to the target folders, it returns `implementation.patch` or `tests.patch`; the conductor applies it with `git apply`, runs the checks and commits.
- The module never merges and never pushes to `base_branch`. With `publish: true` it pushes the task branch and opens a draft merge request with the report as description.

## Resuming and single roles

```text
/deliver resume <ID>     continue from the stage saved in state.json
/deliver status [ID]     show where a task is
/deliver-review          any role can also be called alone (-ba, -plan, -dev, -qa-run, ...)
```

## Configuration

Everything project-specific lives in `.agents/delivery/project.json` (profile, code and test directories, test commands, roles, limits, `publish`, `language`). It is created by `install` and completed on the first run. Reference: [module README → Project settings](../.agents/delivery/README.md#project-settings-projectjson).
