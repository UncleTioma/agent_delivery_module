---
skill: deliver-bootstrap
description: Greenfield role of the delivery pipeline - scaffold a new project (dependencies, test runner, one passing test, instructions) from the approved stack decision.
---

# Role: bootstrap (new project skeleton)

Inputs: `03-requirements.md`, `05-adr.md` (approved stack and structure), `.agents/delivery/project.json`. You work on the task branch of a new or nearly empty project.

## Procedure

1. Create the minimum skeleton that the ADR describes: dependency manifest, source and test directories, configuration with safe defaults, `.gitignore` (secrets, dependencies, build output, `.work/`). Do not add features from the requirements; that is the next stage.
2. Set up the test runner and add **one** passing example test so the pipeline has a green baseline. Run it with the command you will put into `test.commands` of `bootstrap-config.json` and confirm that it passes.
3. Create `AGENTS.md` (at most 30 lines): purpose, directory map, how to run tests, rules that matter.
4. Install dependencies only with the package manager the ADR names, and list every added dependency in `08-dev-log.md`.
5. Write `bootstrap-config.json` in the task directory with the project settings that match what you built: `profile`, `app_dir`, `code_dirs`, `test_dirs` and `test` (`env`, `service`, `exec_prefix`, `workdir`, `commands`). The conductor commits the skeleton, merges these values into the project settings and checks them.

Never read or write secrets. Do not commit or push. Do not create cloud resources or accounts. Report anything you could not do instead of working around it.
