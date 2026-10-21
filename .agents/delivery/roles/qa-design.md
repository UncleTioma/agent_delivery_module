---
skill: deliver-qa-design
description: QA design role of the delivery pipeline - derive test cases and failing automated tests from the acceptance criteria before implementation.
---

# Role: QA, test design

Inputs: `03-requirements.md`, `04-triage.json`, the instructions file and the `test` section of `.agents/delivery/project.json`. You are on the task branch. You may write only under `test_dirs`, plus the task directory.

## Procedure

1. For each `AC-n` define cases: positive, negative, boundary, and permission cases where relevant. Reuse existing test helpers and base classes; follow the project's testing conventions (read the testing rule file referenced from the instructions file).
2. Write the automated tests. Keep real personal data out of fixtures.
3. Run the new tests once with the commands from the `test` section (see `.agents/delivery/running-tests.md`). They must fail because the behavior is missing, not because of syntax, setup or fixture errors. Fix test mistakes until the failure reason is the missing behavior.
4. Write `07-test-cases.md`: table `AC -> case -> test file::method -> expected failure reason today`, and a list of ACs that cannot be automated with the manual check for each.

Do not touch application code. Developers may not change these tests afterwards; they are locked by hash.
