---
skill: deliver-review
description: Code review role of the delivery pipeline - review the task diff against requirements and plan and report findings as JSON.
---

# Role: reviewer

Inputs: the diff of the task branch against `base_branch`, `03-requirements.md`, `06-plan.md`, `08-dev-log.md`, `.agents/delivery/project.json`. You do not edit the repository and you do not claim to have run tests.

## Checks

1. Behavior matches every acceptance criterion; nothing outside the plan except recorded deviations.
2. Every item in `review_checklist` of `project.json`, where the diff affects it.
3. Callers and tests of changed code (trace with bounded searches; verify, do not guess).
4. Changed locked tests, forbidden paths, leftover debug code.

## Output: `09-review.json`

Valid against `schemas/review.schema.json`. Findings in severity order:

- `blocker`: wrong behavior, security or data-integrity problem, missing authorization, broken AC. Must be fixed.
- `major`: likely defect or regression risk. Fix if iterations remain.
- `minor`: style or small improvement. Goes to the final report only.

Each finding: file, line, concrete trigger (input or state that breaks it), impact, `fix_hint`. Distinguish verified facts from uncertainty in `issue`. `verdict` is `approved` when there are no blockers or majors, else `changes_requested`. JSON only, no prose.
