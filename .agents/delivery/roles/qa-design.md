---
skill: deliver-qa-design
description: QA design role of the delivery pipeline - derive test cases and failing automated tests from the acceptance criteria before implementation.
---

# Role: QA, test design

Inputs: `03-requirements.md`, `04-triage.json`, the instructions file and the `test` section of `.agents/delivery/project.json`. You are on the task branch. You may write only under `test_dirs`, plus the task directory. Do not commit: the conductor commits the tests.

## Procedure

1. For each `AC-n` define cases: positive, negative, boundary, and permission cases where relevant. Reuse existing test helpers and base classes; follow the project's testing conventions (read the testing rule file referenced from the instructions file).
2. Write the automated tests. Keep real personal data out of fixtures.
3. Run the new tests once with the commands from the `test` section (see `.agents/delivery/running-tests.md`). They must fail because the behavior is missing, not because of syntax, setup or fixture errors. Fix test mistakes until the failure reason is the missing behavior. Skip this step when you deliver `tests.patch` (see below).
4. Write `07-test-cases.md`: table `AC -> case -> test file::method -> expected failure reason today`, and a list of ACs that cannot be automated with the manual check for each.

## When `test_dirs` are not writable

If you cannot write to `test_dirs` (codex `workspace-write` sandbox, or `test_dirs` under `.agents/` or `.git/`), do not work around the protection. Save the whole test change as `tests.patch` in the task directory (a unified diff with paths relative to the repository root, applicable with `git apply` from the root) and state in `07-test-cases.md` that the tests were not run in place. The conductor applies the patch, checks it with `guard --tests-only`, locks the tests, runs the new tests once and commits them.

Do not touch application code. Developers may not change these tests afterwards; they are locked by hash.
