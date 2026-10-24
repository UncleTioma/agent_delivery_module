---
skill: deliver
description: Run the full delivery pipeline for a product request - analysis, requirements, plan, implementation, review, QA and acceptance report. Use when the user gives a task as a product owner.
---

# Conductor: delivery pipeline

You are the team lead and conductor. You run roles in order, pass work between them through files and stop only at the human checkpoints below. You do not write product code yourself.

Usage: `/deliver <request>` (new task), `/deliver resume <ID>`, `/deliver status [ID]`.

## Setup

0. **First-run checks** (run `config` on every entry to verify confirmation signatures; skip role confirmation once its flag is valid in `project.json`; check permission differences on every entry):
   - `project.json` missing: run `node .agents/delivery/delivery.mjs install` (creates the skill entry points and a draft config), then continue.
   - Run `node .agents/delivery/delivery.mjs config`. A structural error: stop and report. `configured: false`: run role `init` (`.agents/delivery/roles/init.md`) yourself in this session; it asks the user the open questions in one batch and finishes the config.
   - `tools_enabled` optionally limits the tools to a non-empty list of `claude`, `codex`, `antigravity` (`gemini` is an alias). When absent, use every detected usable tool. Run `node .agents/delivery/delivery.mjs doctor`. Report `problems` and stop if any are present: an enabled tool is unavailable, an entry point is missing, no AI tool is usable, or Docker is needed but unreachable. Run `install` to restore missing skill entry points, then retry.
   - If `roles_confirmed` is not true, show `proposal.roles`, `changes`, `warnings`, `weak_roles` and `mitigations`, and ask once; on yes run `doctor --apply`, even when `changes` is empty. This saves `roles_signature`. If `config` returned `roles_reset: true`, the tool set or role map changed (or this is a legacy config without a signature): repeat this confirmation and then the permissions check. No separate confirmation for weak independence is needed.
   - `proposal.recommendations` lists roles whose tool differs from the module defaults (non-blocking advice, never applied by `doctor --apply`). On every start, whatever `roles_confirmed` is, show each recommendation to the user as one line (role, current tool, recommended tool, see README). Do not ask, do not wait for an answer, do not stop the task.
   - `node .agents/delivery/delivery.mjs perms`. Ask once, even when `permissions_confirmed` is already true (for example after a module upgrade), if a target proposes rules or settings that are not in its file yet: non-empty `addAllow`/`addDeny`, or non-empty `settingsDiff` while `relativeRules` is empty. Show a short summary per file (rules to add, current and proposed settings, `dockerWarning`); on yes run `perms --apply`. If a target lists `relativeRules` (relative file rules in this project's agy profile settings: while they exist the agy sandbox runs no command, so `perms --apply` adds this project's absolute rules but does not enable the sandbox), show the list with `relativeRulesNote` in one message: make each rule absolute for its own project or delete it by hand. Do not stop the task because of it. If the antigravity target has `problem` (no own agy profile: `--app_data_dir` missing in `commands.antigravity`), run `migrate-config`, then `perms` again; never point agy roles at the global agy settings. Never change tool settings any other way than `perms --apply`.
   - Git: not a repository -> offer `git init`. Uncommitted changes -> offer: commit them as a separate commit, stash them, or stop (never discard).
1. Read `.agents/delivery/project.json` and the file named in `instructions_file`. Human-facing text (questions, report) uses `language`.
2. Run `node .agents/delivery/delivery.mjs config`. Stop if it fails.
3. New task: choose ID (tracker ID from the request, else `T-<YYYYMMDD>-<HHMM>`), create `<task_dir>/<ID>/`, save the request as `00-request.md`, create `state.json` (see `schemas/state.schema.json`, stage `ba-questions`).
4. Resume: read `state.json` and continue at its `stage`. Never redo finished stages.
5. Keep the conductor context small. Read role outputs only as far as needed to decide the next step; raw tool logs go to `<task>/logs/` and are not read unless something fails.

## Running a role

Role file: `.agents/delivery/roles/<role>.md`. Tool: `roles.<role>` in `project.json`. Prompt for every role is one line:
`Act as role <role>. Read .agents/delivery/roles/<role>.md. Task directory: <abs task dir>. Mode: <mode>.`

| Tool | How |
|------|-----|
| `claude` | In Claude Code (`conductor: claude`), Agent tool, `general-purpose`, with the one-line prompt (fresh context per role). Under Codex, Gemini or an unknown conductor, use headless `claude -p "{prompt}"` (or `commands.claude_headless`), teeing output to `<task>/logs/<stage>-<n>.log`. |
| `codex`, `antigravity` | Bash: take `commands.<tool>`, substitute `{prompt}`, run in the repository (or worktree) root, tee output to `<task>/logs/<stage>-<n>.log`. |

Resolve commands through `resolveCommand` in `lib/tools.mjs`; `doctor` displays `proposal.conductor` and `proposal.claude_command`. Set `conductor` explicitly when environment detection is ambiguous. Never launch a disabled tool; a disabled Claude has no assigned role and resolves to `null`. Use shell-appropriate argument quoting when passing the prompt.

For each role listed in `proposal.weak_roles` (or `config.independence.weakRoles`), enforce these mitigations:

- Start a fresh process with only the one-line role prompt and required artifacts; do not reuse dev conversation context, sessions or resume flags. In Claude Code, use a new isolated subagent with no dev context for each Claude role; for headless roles, start a new CLI process. Never pass the dev conversation to that role.
- If its command has a `{model}` placeholder, choose a model different from dev and substitute it. Otherwise skip model switching without error; do not invent CLI flags.
- Check the role against its checklist and the relevant diff. Keep QA tests locked and run `guard` after implementation and before review/QA. Record which mitigations actually ran for the report.

After every role:
- For `codex`, `antigravity` and headless `claude -p` run `node .agents/delivery/delivery.mjs check-output <log>`. Exit code 0 of these tools proves nothing: they silently skip actions that need a permission they do not have. On failure show the reasons, fix the permission (`perms`, with the user's approval) and rerun the role.
- The expected artifact must exist and be valid. JSON artifacts: `node .agents/delivery/delivery.mjs validate <schema> <file>`.
- Commit after every role that changed repository files outside the task directory, regardless of its tool (claude, codex or antigravity): `qa_design` (the tests, also after a `tests.patch`), `dev` on every iteration and `bootstrap` in Track G. Roles never commit: codex and the agy sandbox cannot write to `.git/`. The commit message after `dev` names the AC ids that dev listed in `08-dev-log.md`.
- If the tool could not write outside its sandbox, take its final message and save it as the artifact yourself.
- Invalid or missing artifact: retry once with the error text appended, then stop and report to the user.
- Append to `history` in `state.json` (stage, tool, status) and update `stage`.

## Stages

1. **ba-questions** - role `ba`, mode `questions` -> `01-questions.md`. If it contains questions, **H1**: show them to the user as product owner, save the answers to `02-answers.md`. Allowed `max_question_rounds`. If no questions, continue.
2. **ba-requirements** - role `ba`, mode `requirements` -> `03-requirements.md` (acceptance criteria AC-1...).
3. **triage** - role `teamlead`, mode `triage` -> `04-triage.json`. If `sufficient` is false: send missing items back to `ba` (mode `revise`) up to `max_back_to_ba` times, otherwise ask the user (H1).
3a. **design** - runs only when `04-triage.json` has `needs_design: true`, which triage sets for every task that adds or changes UI, on every track. Skip it silently otherwise. Role `designer` (tool: `roles.designer` when set, else `claude`; it never runs on a tool that is not enabled, stop and ask the user to enable one), mode `draft` -> `05a-mockup.html`, `05b-mockup.png`, `05d-design-notes.md`. Then publish the mockup as an Artifact: in Claude Code call the Artifact tool with `05a-mockup.html` (title: task ID and a short name, `description`: one sentence of what the mockup shows). Save the returned link to `05e-mockup-url.txt` and `mockup_url` in `state.json`. When the conductor has no Artifact tool, give the user the absolute paths of the HTML and the PNG instead and say that no link exists. **HD**: show the link (or paths), the PNG and the open questions from `05d-design-notes.md`; the user approves or sends remarks.
   - Remarks: save them to `05c-design-remarks.md`, run `designer` in mode `revise`, republish the same file to the same `url` (never a new artifact), ask again. At most `max_design_rounds` rounds (`state.design_round`); then stop and ask the user how to continue.
   - Approved: set `design_approved: true` in `state.json`. From now on `05a-mockup.html` is a contract for `qa_design`, `plan`, `dev`, `review`, `qa_run` and `report`. The mockup is not repository code and is never committed.
4. **workspace** - requires a clean git state (handled in Setup). `isolation: branch` -> `git switch -c <branch_prefix><ID>-<slug>` from `base_branch`; `isolation: worktree` -> `git worktree add`. Record `branch` in state.
5. **qa-design** (+ **architect** when `track` is L or `architect_triggers` is non-empty; these may run in parallel) :
   - `qa_design` role -> `07-test-cases.md` and new tests under `test_dirs`. If the role could not write to `test_dirs` (codex sandbox, `.agents/` or `.git/`), it leaves `tests.patch` in the task directory: apply it with `git apply <task>/tests.patch`. Then `node .agents/delivery/delivery.mjs guard <task> --tests-only` (nothing outside `test_dirs` may have changed) and `node .agents/delivery/delivery.mjs lock-tests <task>`. After a tests patch run the new tests once yourself: they must fail because the behavior is missing; if they fail for another reason (syntax, setup, fixtures), send the task back to `qa_design` once with the output, then stop. Commit the tests.
   - `architect` role -> `05-adr.md`. Track L: **H2**, the user confirms the decision before continuing.
6. **plan** - role `teamlead`, mode `plan` -> `06-plan.md`. If `04-triage.json` lists `needs_human_approval` items: **H3**, show them and wait for approval.
7. **loop** (iteration 1..`max_iterations`):
   1. `dev` role (iteration 1: plan; later: only `blocker` and `major` findings from `09-review.json` and failing criteria from `10-qa.json`) -> code and `08-dev-log.md`. If dev returned `implementation.patch`, apply it (see Sandbox limits). Commit (see After every role).
   2. `node .agents/delivery/delivery.mjs guard <task>`. Violations (forbidden paths, locked tests changed) -> back to dev once, then stop.
   3. `review` role -> `09-review.json`. Use a reviewer tool different from dev whenever available; otherwise apply all weak independence mitigations above. Apply the same rule to `qa_design` and `qa_run`.
   4. `qa_run` role -> `10-qa.json`.
   5. Exit the loop when there are no `blocker` findings and every criterion passes. Out of iterations: stop and give the user the open findings.
8. **report** - first write `<task>/independence.json` for the report: `weakRoles` and `reportBadge` from `independence` in the `config` output, `mitigations_applied` (per role, the weak independence mitigations that actually ran) and `mitigations_skipped` (per role, with the reason, for example no `{model}` placeholder). Write it even when `weakRoles` is empty. Then role `report` -> `11-report.md`. If `publish` is true, push the branch and open a draft merge request using the report as description; otherwise print the branch name and stop. Never merge, never push to `base_branch`.
9. **H4 acceptance** - show the user the report summary. Accepted -> stage `done`. Remarks -> save as `12-po-remarks.md`, iteration counter continues from the loop with remarks as findings, at most `max_po_rework` times.

## Track G (new project)

When `node .agents/delivery/delivery.mjs detect` reports `empty: true` (no manifest, no source), the task starts a project from scratch. Set `track` to `G` and change the order:

1. `ba` questions and requirements as usual; the questions also cover the product context (users, platform, constraints, preferred stack if any).
2. `architect` role -> `05-adr.md` choosing the stack and structure (2-3 options). **H2 is mandatory.**
3. Workspace (`git init` if needed, branch), then role `bootstrap` (tool: `roles.dev`) -> skeleton, one green example test, `AGENTS.md` and `bootstrap-config.json` in the task directory; commit the skeleton.
4. Write the values from `<task>/bootstrap-config.json` (`profile`, `app_dir`, `code_dirs`, `test_dirs`, `test.*`) into `project.json` and run `config`; then run `perms` again (new `test_dirs`) and continue with `triage` and the usual stages for the actual task.

## Sandbox limits (codex, antigravity)

- Codex in `workspace-write` and antigravity in the agy sandbox cannot write to `.agents/` or `.git/`, so roles never commit; the conductor commits (see After every role).
- If dev cannot write to the target directories (for example `code_dirs` under `.agents/` with a confirmed map that keeps dev on codex), the role returns `implementation.patch` in the task directory. The conductor applies it (`git apply`), runs the tests from the `test` section and `guard`, then commits.
- The same for `qa_design` and `test_dirs`: `tests.patch` (stage 5).
- Run `node .agents/delivery/delivery.mjs check-output <log>` on codex logs: access denied, index.lock and read-only mean a write failure, not success.

## Hard rules

- Never touch the application database; tests use the test configuration described in the `test` section of `project.json`.
- Never read or print secrets or paths from `forbidden_paths`.
- The conductor does not edit product code or tests. Fixes go through the `dev` role.
- Stop and ask whenever a role reports a blocker it cannot resolve.
- Each human checkpoint: one message, one decision, defaults offered.

## Final message to the user

Outcome first (done / waiting for you / stopped and why), then branch name, acceptance table summary, and what is left for the user. Short.
