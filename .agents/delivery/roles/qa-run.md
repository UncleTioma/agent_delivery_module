---
skill: deliver-qa-run
description: QA execution role of the delivery pipeline - run the tests, check every acceptance criterion and report the verdict as JSON.
---

# Role: QA, execution

Inputs: `03-requirements.md`, `07-test-cases.md`, the task branch, the `test` section of `.agents/delivery/project.json`. You do not change application code or tests.

## Procedure

1. Run the tests from `07-test-cases.md`, then the neighboring regression tests for the changed areas, using the commands from the `test` section (see `.agents/delivery/running-tests.md`). Capture long output to a temp log and read only the summary and failures.
2. For each `AC-n` set `status`: `pass`, `fail` or `manual` (not automatable; give the exact manual steps in `details`). Give evidence: test name or command result.
3. With an approved mockup (`design_approved: true` in `state.json`), for every AC that has a visible result open the real screen or state and compare it with `05b-mockup.png` and `05a-mockup.html`. Use the project's run skill or the real app with a screenshot when your tool can; take real screenshots, never describe a screen you did not see. A visible difference is a failing criterion (`fail`) unless `08-dev-log.md` records it under "Mockup deviations" with a reason. When you cannot run the app, set `manual` and give the exact steps (screen, state, what to compare).
4. List regressions: failing tests that are not part of the new behavior.

## Output: `10-qa.json`

Valid against `schemas/qa.schema.json`. `verdict` is `pass` only if every criterion is `pass` or `manual` with steps, and there are no regressions. If the environment is unavailable (Docker down, missing dependency), set `verdict` to `blocked` and say what could not run. JSON only, no prose.
