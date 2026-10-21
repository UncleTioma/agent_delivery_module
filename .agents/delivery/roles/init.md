---
skill: deliver-init
description: First-run setup interview of the delivery pipeline - confirm the detected stack, test commands and options, and finish project.json. Use when .agents/delivery/project.json is not configured yet.
---

# Role: project setup (interview)

Inputs: `.agents/delivery/project.json` (draft with `configured: false` and an `unresolved` list) and the output of `node .agents/delivery/delivery.mjs detect`. You run in the conductor's session and talk to the user directly.

## Procedure

1. Run `node .agents/delivery/delivery.mjs detect`. Tell the user in at most five lines what was found: stack and profile, where the application lives, how tests will run (command and environment), git state, instruction files.
2. Ask the entries of `unresolved` as **one batch** of at most five questions. Use the interactive question tool when you have it; otherwise a numbered list. Every question has the default from the entry (or your best guess) and says what it affects. Do not ask anything that detection already answered.
3. Apply the answers to `project.json` (edit only the keys concerned):
   - `language`: language of questions and reports.
   - `test.env`, `test.service`, `test.exec_prefix`, `test.workdir`: how tests run (Docker or local).
   - `test.commands.file`, `test.commands.suite`, `test.commands.lint`: use `{path}`, `{suite}`, `{file}` placeholders.
   - `profile`: when the stack was not recognised, set the closest profile id from `.agents/delivery/profiles/` or keep `generic` and put the real commands into `test.commands`.
   - `publish`: `true` only if the user wants the branch pushed and a draft merge request opened.
4. Not a git repository and the user agreed: `git init`, and set `base_branch` to the current branch.
5. No instructions file and the user agreed: create `AGENTS.md` (at most 30 lines): what the project is, directory map, how to run tests, rules that matter (database isolation, secrets). Base it on facts you verified in the repository.
6. Check that the test runner starts: run the runner binary with `--version` or `--help` the way `.agents/delivery/running-tests.md` describes (including `test.exec_prefix`). Report the result. If it cannot start, tell the user what is missing; do not change application files to fix it.
7. Set `configured: true`, `unresolved: []`, then run `node .agents/delivery/delivery.mjs config`. It must report `ok`. Show the user the final summary: profile, test command, roles, language.

Never read or print secrets. Never run commands that modify a database.
