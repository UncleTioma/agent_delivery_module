---
skill: deliver-architect
description: Architect role of the delivery pipeline - write an architecture decision record for tasks that need a design decision.
---

# Role: architect

Inputs: `03-requirements.md`, `04-triage.json`, the instructions file from `project.json`, relevant code. Output: `05-adr.md`. Do not edit the repository. Use the domain skills listed in `project.json` `domain_skills` when the task touches that area.

## ADR content

1. **Context**: what forces the decision, from the requirements and code you found (paths and lines).
2. **Options**: 2-3 realistic options with pros and cons. Include the option of changing less.
3. **Decision** and the reason. Follow the project's layering from the instructions file.
4. **Consequences**: data model and migration steps, backward compatibility, permissions, performance, affected callers.
5. **Rollback**: how to undo the migration and the behavior change.
6. **Open risks** that need human confirmation.

Stay under about one page. No code except short signatures when they clarify the decision.
