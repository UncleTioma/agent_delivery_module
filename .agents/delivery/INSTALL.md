# Installing the delivery module (instructions for an AI agent)

Use this file when the user says "install the delivery module" and Node.js is not available. With Node, run `node .agents/delivery/delivery.mjs install` instead and follow its output.

Do these steps in the repository root. Stop and tell the user if any step cannot be done.

1. **Skills.** For every file `.agents/delivery/roles/*.md` read the frontmatter keys `skill` and `description`. For each role create two files with identical content, `.agents/skills/<skill>/SKILL.md` and `.claude/skills/<skill>/SKILL.md`:

   ```text
   ---
   name: <skill>
   description: <description>
   ---

   Read `.agents/delivery/roles/<file>` and follow it. Load it only when this skill is used.
   Project settings: `.agents/delivery/project.json`.
   ```

   Claude Code reads skills only from `.claude/skills/`; Codex and Antigravity read `.agents/skills/`.
2. **Ignore rules.** Add `.work/` to `.gitignore`. If `.gitignore` ignores `.agents/*`, add the exception `!.agents/delivery/` and `!.agents/skills/`.
3. **Project file.** Copy nothing: create `.agents/delivery/project.json` from the schema in `project.schema.json`:
   - read the dependency manifests (`composer.json`, `package.json`, `pyproject.toml`, `requirements.txt`) and pick the profile from `.agents/delivery/profiles/*.json` whose `detect` rules match (use `generic` when none matches);
   - copy `test`, `forbidden_paths`, `architect_triggers`, `review_checklist` from that profile;
   - set `configured: false`, `language: null`, `roles` to the default map (`ba`, `teamlead`, `report` → `claude`; `architect`, `review`, `qa_design`, `qa_run` → `antigravity`; `dev` → `codex`), `commands` (`codex`: `codex exec --sandbox workspace-write "{prompt}"`, `antigravity`: `agy -p "{prompt}" --output-format json --print-timeout 30m --effort high`, `claude`: `subagent`), `roles_confirmed: false`, `permissions_confirmed: false`, and list unanswered items in `unresolved`.
4. **Permissions.** Do not edit tool settings. Once Node.js is available, `node .agents/delivery/delivery.mjs perms` generates the rules: for agy the sandbox settings (`toolPermission: "proceed-in-sandbox"`, `enableTerminalSandbox: true`) and file rules with absolute paths of this project; only `perms --apply`, after the human confirms, writes them. Until then list the commands the pipeline runs (`git`, the test command, `codex exec`, `agy -p`) and ask the user to allow them.
5. **Finish.** Tell the user to open the project in Claude Code or Codex (the conductor; agy runs roles only) and run `/deliver <task>`; the first run asks the remaining questions.
