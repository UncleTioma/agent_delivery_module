---
skill: deliver-qa-run
description: QA execution role of the delivery pipeline - run the tests, check every acceptance criterion and report the verdict as JSON.
---

# Role: QA, execution

Inputs: `03-requirements.md`, `07-test-cases.md`, the task branch, the `test` section of `.agents/delivery/project.json`. You do not change application code or tests.

## Procedure

1. Run the tests from `07-test-cases.md`, then the neighboring regression tests for the changed areas, using the commands from the `test` section (see `.agents/delivery/running-tests.md`). Capture long output to a temp log and read only the summary and failures.
2. For each `AC-n` set `status`: `pass`, `fail` or `manual` (not automatable; give the exact manual steps in `details`). Give evidence: test name or command result.
3. List regressions: failing tests that are not part of the new behavior.

## Output: `10-qa.json`

Valid against `schemas/qa.schema.json`. `verdict` is `pass` only if every criterion is `pass` or `manual` with steps, and there are no regressions. If the environment is unavailable (Docker down, missing dependency), set `verdict` to `blocked` and say what could not run. JSON only, no prose.
