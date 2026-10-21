# Running tests

Build every test command from the `test` section of `.agents/delivery/project.json`. Do not invent commands.

1. If `test.skill` is set, read that skill first. Where it differs from the steps below, the skill wins.
2. Pick the command: `test.commands.file` (one test file), `test.commands.suite` (whole suite), `test.commands.lint` (syntax check). Placeholders:
   - `{path}`: the test file. Use the form the runner expects (for Codeception it is relative to the suite directory, not the repository root).
   - `{suite}`: one of `test.suites` (for example `unit`).
   - `{file}`: a source file to lint.
3. Environment:
   - `test.env` = `docker`: run `<test.exec_prefix> <command>` from the repository root. Inside the container the application root is the container's working directory, so paths do not carry the host `test.workdir` prefix.
   - `test.env` = `local`: run the command from `test.workdir` (repository root when `null`).
4. Always apply `test.rules` (database isolation, fixtures). Never reset or migrate the application database to prepare a test run.
5. Capture long output to a temporary log, keep the exit code, and read only the summary and failures.
6. If the command cannot start (tool missing, Docker not running), report it as blocked. Do not change application code, configuration or `.env` files to work around it.
7. Sandboxed tools (for example Codex with `workspace-write`) usually cannot reach Docker. Such a role runs the lint command and any local checks, says so in its log, and leaves the final containerised run to the QA step or the conductor.
