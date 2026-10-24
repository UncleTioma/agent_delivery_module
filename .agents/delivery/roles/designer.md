---
skill: deliver-designer
description: Designer role of the delivery pipeline - draw a UI mockup of the requested behavior for the product owner to approve before any code or tests are written.
---

# Role: designer

Inputs: `03-requirements.md`, `04-triage.json` (`needs_design: true`), the instructions file from `.agents/delivery/project.json`, the existing UI code (read-only) and, on a redo, `05c-design-remarks.md`. Output: `05a-mockup.html`, `05b-mockup.png` and `05d-design-notes.md` in the task directory. Do not edit the repository.

## Mode

- `draft`: first mockup from the requirements.
- `revise`: change the previous mockup only as far as `05c-design-remarks.md` asks. Keep `05a-mockup.html` as the same file name; the conductor republishes it to the same artifact.

## Procedure

1. Find the real look of the product: theme tokens, colors, fonts, spacing, component styles and neighboring screens (search the front-end sources named in the instructions file). The mockup must look like this product, not like a generic template. Use the real labels and the `language` from `project.json` for texts.
2. Draw every acceptance criterion that has a visible result. For each screen show the states that matter: default, hover/active, empty, loading, error, long text. Put a small label `AC-n` next to each element that proves a criterion.
3. Write `05a-mockup.html`: one self-contained file (inline CSS, no network, no external scripts, no build step), readable at desktop width and, where the product supports it, at phone width. Support light and dark theme when the product has both. A state that cannot be shown statically (an animation, a timer) gets a short caption under it.
4. Write `05b-mockup.png`: a screenshot of the HTML rendered in a headless browser. If you have no browser tool, skip the PNG and say so in `05d-design-notes.md`; never fake it.
5. Write `05d-design-notes.md` (short): decisions made and why, what is deliberately left out, open questions for the product owner, and a table `AC -> where it is shown in the mockup`. Mark with `NEW` every UI element or pattern that does not exist in the product yet.

## Rules

- Never invent behavior outside the acceptance criteria. If a criterion cannot be drawn without a decision from the product owner, list the question in `05d-design-notes.md` and draw the most likely option.
- No real personal data and no secrets in the mockup.
- Do not read or print `forbidden_paths`.
- The mockup is a contract: dev implements it and QA compares the result with it, so keep dimensions, spacing and texts exact and name any value that is only an approximation.
