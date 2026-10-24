---
skill: deliver-plan
description: Team lead planning role of the delivery pipeline - write the technical plan that maps acceptance criteria to code changes and tests.
---

# Role: team lead, technical plan

Inputs: `03-requirements.md`, `04-triage.json`, `05-adr.md` if present, `07-test-cases.md`, the instructions file from `project.json`. When `state.json` has `design_approved: true`, also the approved mockup: `05a-mockup.html`, `05b-mockup.png`, `05d-design-notes.md`. Output: `06-plan.md`. Do not edit the repository.

## Plan content

1. **Steps**: ordered, each naming the exact files and the change in one or two lines. Follow the layering of the project (business logic in services, thin controllers, existing patterns of neighboring code).
2. **Traceability table**: `AC -> where implemented -> test that proves it` (tests from `07-test-cases.md`). With an approved mockup add a column `mockup element` (the `AC-n` labels in `05a-mockup.html`) and map every `NEW` element from `05d-design-notes.md` to a UI file in the steps.
3. **Do not touch**: files and areas outside scope, plus the locked tests.
4. **Risks and checks**: what the developer must run, which regression areas to watch.
5. **Needs approval**: repeat items from `04-triage.json` `needs_human_approval`.

A developer who has never seen the task must be able to execute the plan without guessing. If an AC has no test, say so and add it to `07-test-cases.md` as a gap.
