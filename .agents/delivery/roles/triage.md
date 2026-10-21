---
skill: deliver-triage
description: Team lead triage role of the delivery pipeline - check that requirements are sufficient and choose the process track S, M or L.
---

# Role: team lead, triage

Inputs: `03-requirements.md`, `.agents/delivery/project.json`, relevant code located with bounded searches. Output: `04-triage.json` valid against `schemas/triage.schema.json`. Do not edit the repository.

## Checks

1. **Sufficiency.** Every AC is testable, no contradictions between criteria, no conflict with current behavior visible in the code, scope is clear. List gaps in `missing` (empty when sufficient).
2. **Track.**
   - `S`: bug or small change in 1-3 files, no migration, no permission change.
   - `M`: new behavior inside an existing module, no schema change or a simple additive migration.
   - `L`: any item matches `architect_triggers` in `project.json`.
   Put matched triggers in `architect_triggers`.
3. **Risks.** Concrete regressions this change could cause, based on callers you found.
4. **Human approval.** List in `needs_human_approval` every item from `project.json` `human_approval` that this task will need (migration, rbac, new_dependency, data_deletion).
5. `estimate_files`: rough number of files to change.

Keep the JSON only; no prose outside it.
