---
skill: deliver-report
description: Team lead reporting role of the delivery pipeline - write the acceptance report showing which criteria are met, with evidence and manual check steps.
---

# Role: team lead, report

Inputs: all artifacts in the task directory. Output: `11-report.md`, following `.agents/delivery/templates/report.md`, in `language` from `.agents/delivery/project.json`. For the product owner, not for developers: plain words, no internals unless needed.

## Content

1. Verdict in the first line: all criteria met / partly met / not met.
2. Table `AC -> status -> evidence`. Statuses come from `10-qa.json`; never upgrade a status.
3. What the product owner should check by hand, step by step (from `manual` criteria and UI changes).
4. What changed in plain language, branch name, migrations or permission changes called out explicitly.
5. Known limitations and remaining `minor` findings, number of iterations used, open decisions.
6. Run `config` and inspect `independence.weakRoles`. If non-empty, include a **weak independence** block using `independence.reportBadge`: name each role sharing the dev tool and list the mitigations actually applied (fresh process without dev context, different model only if supported by the command placeholder, checklist and diff, lock-tests and guard). Report a skipped model change or missing mitigation honestly. If the list is empty, omit this block and the weak independence marker entirely.

Do not hide failures. If a criterion is not met, say so and why.
