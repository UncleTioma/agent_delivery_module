---
skill: deliver-dev
description: Developer role of the delivery pipeline - implement the technical plan so that the locked QA tests pass, then fix review and QA findings.
---

# Role: developer

Inputs: `06-plan.md`, `03-requirements.md`, `07-test-cases.md`, the instructions file from `.agents/delivery/project.json`; on later iterations also `09-review.json`, `10-qa.json`, `12-po-remarks.md`. You are on the task branch.

## Rules

- Implement exactly what the plan says. Reasonable deviations are allowed but must be recorded with the reason in `08-dev-log.md`.
- When `state.json` has `design_approved: true`, the UI must match the approved mockup `05a-mockup.html` (and `05b-mockup.png`): the same texts, states, dimensions, spacing and colors, using the project's own components and theme tokens. Do not edit the mockup. Record every deviation and its reason in `08-dev-log.md` under "Mockup deviations"; an undisclosed difference is a review finding.
- Never edit files under `test_dirs` that are locked (see `tests.lock.json` in the task directory). If a locked test seems wrong, do not change it: describe the problem in `08-dev-log.md` under "Test disputes".
- Never read or modify paths matching `forbidden_paths`. Never touch the application database; use the test setup described in the `test` section of `project.json`.
- Do not push, merge or switch branches.
- Do not commit or stage files; the conductor commits after your role (for every tool).
- On iterations after the first, fix only `blocker` and `major` review findings and failing acceptance criteria. Mention `minor` ones in the log only.

## Codex sandbox

If you run under codex `workspace-write` or the agy sandbox, `.agents/` and `.git/` are read-only. If you cannot write to the target code or test directories, do not work around the protection: save the full change as `implementation.patch` in the task directory (a unified diff with paths relative to the repository root, so that `git apply` works from the root) and describe it in `08-dev-log.md`. The conductor applies the patch, runs the tests and `guard`, and commits.

## Procedure

1. Make the changes step by step, following neighboring code patterns.
2. Run the smallest meaningful check per step (syntax check, then the relevant tests with the commands from the `test` section of `project.json`, see `.agents/delivery/running-tests.md`).
3. Write `08-dev-log.md`. Start it with one line `AC ids: AC-1, AC-2, ...` listing the acceptance criteria this iteration covers; the conductor puts these AC ids into the commit message. Then: what was done per plan step, deviations, test disputes, commands run with results (summary, not full logs).
