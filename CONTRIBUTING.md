# Contributing

Thanks for helping. The module is small and has no dependencies; please keep it that way.

## Setup

You need Node.js 18+ and git. Nothing to install:

```bash
git clone https://github.com/UncleTioma/agent_delivery_module.git
cd agent_delivery_module
node .agents/delivery/delivery.mjs selftest     # must print "ok": true
```

`selftest` runs on temporary fixtures, calls no AI tool and spends no tokens. Run it before every pull request.

## Where things live

| Change | Edit |
|---|---|
| Behavior of a role | `.agents/delivery/roles/<role>.md` (the skill entry points are generated, don't edit them) |
| Process rules, CLI | `.agents/delivery/delivery.mjs`, `.agents/delivery/lib/` |
| A new stack | `.agents/delivery/profiles/<id>.json` + detection rules in the profile |
| Artifact formats | `.agents/delivery/schemas/`, `.agents/delivery/templates/` |
| Tests | `.agents/delivery/lib/selftest.mjs` |

After changing a role's frontmatter (`skill`, `description`), regenerate the entry points and check them:

```bash
node .agents/delivery/delivery.mjs install
node .agents/delivery/delivery.mjs install --check
```

## Guidelines

- Rules that must always hold belong in `delivery.mjs` and are covered by a `selftest` check; prompts alone are not enforcement.
- Add a `selftest` check with every behavior change. Update the check count in the README if it changes.
- Keep role prompts short and concrete. Don't assume the role runs on a specific tool; any role can land on Claude, Codex or Antigravity.
- Bump `.agents/delivery/VERSION` for user-visible changes. `upgrade` and `migrate-config` must keep working for existing `project.json` files.
- Don't commit your own `project.json` or anything from `.work/`.

## Reporting problems

Open an issue with: OS, Node version, which tools are installed (`node .agents/delivery/delivery.mjs doctor`), the command you ran and its JSON output. Never paste secrets or private code.
