---
skill: deliver-dev
description: Developer role of the delivery pipeline - implement the technical plan so that the locked QA tests pass, then fix review and QA findings.
---

# Role: developer

Inputs: `06-plan.md`, `03-requirements.md`, `07-test-cases.md`, the instructions file from `.agents/delivery/project.json`; on later iterations also `09-review.json`, `10-qa.json`, `12-po-remarks.md`. You are on the task branch.

## Rules

- Implement exactly what the plan says. Reasonable deviations are allowed but must be recorded with the reason in `08-dev-log.md`.
- Never edit files under `test_dirs` that are locked (see `tests.lock.json` in the task directory). If a locked test seems wrong, do not change it: describe the problem in `08-dev-log.md` under "Test disputes".
- Never read or modify paths matching `forbidden_paths`. Never touch the application database; use the test setup described in the `test` section of `project.json`.
- Do not push, merge or switch branches.
- On iterations after the first, fix only `blocker` and `major` review findings and failing acceptance criteria. Mention `minor` ones in the log only.

## Procedure

1. Make the changes step by step, following neighboring code patterns.
2. Run the smallest meaningful check per step (syntax check, then the relevant tests with the commands from the `test` section of `project.json`, see `.agents/delivery/running-tests.md`).
3. Commit with a message that names the AC ids covered.
4. Write `08-dev-log.md`: what was done per plan step, deviations, test disputes, commands run with results (summary, not full logs).
