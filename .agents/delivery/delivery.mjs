#!/usr/bin/env node
// Delivery module CLI. Zero dependencies, Node 18+.
//
//   node .agents/delivery/delivery.mjs config
//   node .agents/delivery/delivery.mjs detect
//   node .agents/delivery/delivery.mjs init-config [--stdout] [--force]
//   node .agents/delivery/delivery.mjs validate <schema-name> <file>
//   node .agents/delivery/delivery.mjs lock-tests <task-dir>
//   node .agents/delivery/delivery.mjs guard <task-dir>
//   node .agents/delivery/delivery.mjs install [--check]
//
// Exit code: 0 ok, 1 problem found (details as JSON on stdout), 2 usage error.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, relative, sep } from 'node:path';
import {
  moduleDir, root, out, readJson, loadConfig,
  globToRegex, underAny, normalizedHash, changedFiles,
} from './lib/util.mjs';
import { validate } from './lib/schema.mjs';
import { detect, buildDraft, agyProfileName, withAgyProfile } from './lib/detect.mjs';
import {
  inspectTools, inspectBasics, proposeRoles, permsPlan, permsApply, checkToolOutput,
  normalizeTools, checkEntryPoints, detectConductor, resolveCommand, evaluateIndependence, rolesSignature,
  agyProfileProblem, SUBCOMMANDS,
} from './lib/tools.mjs';

const [cmd, ...args] = process.argv.slice(2);

/** Reset stale confirmations in memory; returns the reset keys (nothing is written here). */
function staleConfirmations(cfg) {
  if (cfg.roles_confirmed !== true || cfg.roles_signature === rolesSignature(cfg)) return [];
  const reset = ['roles_confirmed'];
  if (cfg.permissions_confirmed !== false) reset.push('permissions_confirmed');
  cfg.roles_confirmed = false;
  cfg.permissions_confirmed = false;
  return reset;
}

function cmdConfig() {
  const cfg = loadConfig();
  const errors = validate(cfg, readJson(resolve(moduleDir, 'project.schema.json')));
  const roles = cfg.roles ?? {};
  for (const r of ['ba', 'teamlead', 'architect', 'qa_design', 'dev', 'review', 'qa_run', 'report']) {
    if (!roles[r]) errors.push(`roles.${r} not set`);
    else if (!cfg.commands?.[roles[r] === 'gemini' ? 'antigravity' : roles[r]]) errors.push(`roles.${r} uses tool '${roles[r]}' without commands entry`);
  }
  if ('tools_enabled' in cfg) {
    if (!Array.isArray(cfg.tools_enabled) || !cfg.tools_enabled.length) {
      errors.push('tools_enabled must be a non-empty array of tools');
    } else {
      const enabled = normalizeTools(cfg.tools_enabled);
      for (const t of enabled.unknown) errors.push(`tools_enabled: unknown tool '${t}'`);
      for (const [role, tool] of Object.entries(roles)) {
        if (!enabled.tools.includes(tool === 'gemini' ? 'antigravity' : tool)) {
          errors.push(`roles.${role} uses tool '${tool}' which is not in tools_enabled`);
        }
      }
    }
  }
  if (Object.values(roles).some((t) => t === 'antigravity' || t === 'gemini')) {
    const agyProblem = agyProfileProblem(cfg);
    if (agyProblem) errors.push(agyProblem);
  }
  const independence = evaluateIndependence(roles);
  const skill = cfg.test?.skill;
  if (skill && !existsSync(resolve(root, '.agents/skills', skill))) {
    errors.push(`test.skill '${skill}' not found under .agents/skills`);
  }
  if (cfg.configured) {
    if (!cfg.language) errors.push('language not set');
    if (!skill && !cfg.test?.commands?.file) errors.push('no way to run a single test file: set test.commands.file or test.skill');
  }
  const reset = errors.length ? [] : staleConfirmations(cfg);
  if (reset.length) writeFileSync(resolve(moduleDir, 'project.json'), JSON.stringify(cfg, null, 2) + '\n');
  out({
    ok: errors.length === 0, errors, configured: cfg.configured === true, unresolved: cfg.unresolved ?? [],
    independence, warnings: independence.weakIndependence ? [independence.reportBadge] : [],
    reset, roles_reset: reset.length > 0,
  }, errors.length ? 1 : 0);
}

function cmdDetect() {
  out({ ok: true, detected: detect() });
}

function cmdInitConfig() {
  const file = resolve(moduleDir, 'project.json');
  const draft = buildDraft(detect());
  if (args.includes('--stdout')) out(draft);
  const existing = existsSync(file) ? readJson(file) : null;
  if (existing && existing.configured !== false && !args.includes('--force')) {
    out({ ok: false, errors: ['project.json already configured; use --force to overwrite'] }, 1);
  }
  writeFileSync(file, JSON.stringify(draft, null, 2) + '\n');
  out({ ok: true, file: '.agents/delivery/project.json', profile: draft.profile, unresolved: draft.unresolved });
}

function cmdValidate() {
  const [schemaName, file] = args;
  const schemaFile = resolve(moduleDir, 'schemas', `${schemaName}.schema.json`);
  if (!schemaName || !file || !existsSync(schemaFile) || !existsSync(file)) {
    out({ ok: false, errors: ['schema or file not found'] }, 2);
  }
  const schema = readJson(schemaFile);
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    out({ ok: false, errors: [`invalid JSON: ${e.message}`] }, 1);
  }
  const errors = validate(data, schema);
  out({ ok: errors.length === 0, errors }, errors.length ? 1 : 0);
}

function taskDirOrExit() {
  const task = args[0];
  if (!task || !existsSync(task) || !statSync(task).isDirectory()) {
    out({ ok: false, errors: ['task dir not found'] }, 2);
  }
  return resolve(task);
}

function cmdLockTests() {
  const cfg = loadConfig();
  const task = taskDirOrExit();
  const hashes = {};
  for (const f of changedFiles(cfg.base_branch)) {
    const abs = resolve(root, f);
    if (underAny(f, cfg.test_dirs) && existsSync(abs)) hashes[f] = normalizedHash(abs);
  }
  writeFileSync(resolve(task, 'tests.lock.json'), JSON.stringify(hashes, null, 2));
  out({ ok: true, locked: Object.keys(hashes) });
}

function cmdGuard() {
  const cfg = loadConfig();
  const task = taskDirOrExit();
  const violations = [];
  const forbidden = (cfg.forbidden_paths ?? []).map(globToRegex);
  for (const f of changedFiles(cfg.base_branch)) {
    const name = f.split('/').pop();
    if (forbidden.some((re) => re.test(f) || re.test(name))) {
      violations.push(`forbidden path changed: ${f}`);
    }
  }
  if (args.includes('--tests-only')) {
    for (const f of changedFiles(cfg.base_branch)) {
      if (!underAny(f, cfg.test_dirs) && !f.startsWith('.work/')) {
        violations.push(`non-test file changed during test design: ${f}`);
      }
    }
  }
  const lockFile = resolve(task, 'tests.lock.json');
  if (existsSync(lockFile)) {
    for (const [f, hash] of Object.entries(readJson(lockFile) ?? {})) {
      const abs = resolve(root, f);
      if (!existsSync(abs)) violations.push(`locked test removed: ${f}`);
      else if (normalizedHash(abs) !== hash) violations.push(`locked test modified: ${f}`);
    }
  }
  out({ ok: violations.length === 0, violations }, violations.length ? 1 : 0);
}

function frontmatter(file) {
  const m = readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^(\w+):\s*(.+)$/);
      if (kv) meta[kv[1]] = kv[2].trim();
    }
  }
  return meta;
}

function stubContent(name, description, roleRel) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n`
    + `Read \`${roleRel}\` and follow it. Load it only when this skill is used.\n`
    + 'Project settings: `.agents/delivery/project.json`.\n';
}

function cmdInstall() {
  const checkOnly = args.includes('--check');
  const problems = [];
  const written = [];
  const rolesDir = resolve(moduleDir, 'roles');
  for (const file of readdirSync(rolesDir).filter((f) => f.endsWith('.md')).sort()) {
    const meta = frontmatter(resolve(rolesDir, file));
    if (!meta.skill || !meta.description) {
      problems.push(`${file}: missing skill/description in frontmatter`);
      continue;
    }
    const content = stubContent(meta.skill, meta.description, `.agents/delivery/roles/${file}`);
    for (const base of ['.agents/skills', '.claude/skills']) {
      const target = resolve(root, base, meta.skill, 'SKILL.md');
      const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
      if (current !== null && current.replace(/\r\n/g, '\n') === content) continue;
      if (checkOnly) {
        problems.push(`${base}/${meta.skill}/SKILL.md ${current === null ? 'missing' : 'outdated'}`);
        continue;
      }
      mkdirSync(resolve(root, base, meta.skill), { recursive: true });
      writeFileSync(target, content);
      written.push(`${base}/${meta.skill}/SKILL.md`);
    }
  }
  if (!checkOnly) {
    const gi = resolve(root, '.gitignore');
    const text = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
    if (!/^\/?\.work\/?\s*$/m.test(text)) {
      writeFileSync(gi, text.replace(/\s+$/, '') + '\n\n# Delivery pipeline task artifacts.\n.work/\n');
      written.push('.gitignore (+ .work/)');
    }
  }
  let unresolved = [];
  const projectFile = resolve(moduleDir, 'project.json');
  if (!existsSync(projectFile)) {
    if (checkOnly) {
      problems.push('project.json missing: run install');
    } else {
      const draft = buildDraft(detect());
      writeFileSync(projectFile, JSON.stringify(draft, null, 2) + '\n');
      written.push('.agents/delivery/project.json (draft, profile: ' + draft.profile + ')');
      unresolved = draft.unresolved;
    }
  }
  const result = { ok: problems.length === 0, written, problems };
  if (!checkOnly) {
    result.unresolved = unresolved;
    result.next = [
      'Open Claude Code or Codex in this folder (the conductor) and run /deliver <task>: it asks the remaining questions (unresolved) on first run.',
      'Permissions: run perms, review the proposal, then perms --apply after the human confirms (agy: sandbox and absolute paths).',
    ];
  }
  out(result, problems.length ? 1 : 0);
}

function cmdDoctor() {
  const cfg = loadConfig();
  const tools = inspectTools({ probe: args.includes('--probe') });
  const basics = inspectBasics(cfg);
  const plan = proposeRoles(cfg.roles ?? {}, tools, cfg.tools_enabled, {
    code_dirs: cfg.code_dirs, test_dirs: cfg.test_dirs,
    confirmed: cfg.roles_confirmed === true && cfg.roles_signature === rolesSignature(cfg),
  });
  const problems = [...plan.problems];
  if ('tools_enabled' in cfg && !Array.isArray(cfg.tools_enabled)) {
    problems.push('tools_enabled must be a non-empty array of tools');
  }
  const entry = checkEntryPoints(root, Array.isArray(cfg.tools_enabled) ? cfg.tools_enabled : plan.available);
  problems.push(...entry.problems);
  if (!basics.git) problems.push('git not found');
  if (basics.docker.needed && !basics.docker.ok) problems.push('docker compose is not reachable, but tests run in Docker');
  if (!plan.available.length) problems.push('no supported AI tool found (claude, codex, agy)');
  let applied = false;
  if (args.includes('--apply') && !problems.length) {
    cfg.roles = plan.roles;
    const signature = rolesSignature(cfg);
    if (cfg.roles_signature !== signature) cfg.permissions_confirmed = false;
    cfg.roles_confirmed = true;
    cfg.roles_signature = signature;
    writeFileSync(resolve(moduleDir, 'project.json'), JSON.stringify(cfg, null, 2) + '\n');
    applied = true;
  }
  const conductor = detectConductor(cfg);
  out({
    ok: problems.length === 0, basics, tools,
    proposal: {
      roles: plan.roles, changes: plan.changes, warnings: plan.warnings, weak_independence: !!plan.weakIndependence,
      recommendations: plan.recommendations,
      weak_roles: plan.weakRoles, mitigations: plan.mitigations, report_badge: plan.reportBadge,
      conductor, claude_command: resolveCommand('claude', cfg, { conductor }),
    },
    problems, applied,
  }, problems.length ? 1 : 0);
}

function cmdPerms() {
  const cfg = loadConfig();
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.slice(7).split(',').filter(Boolean) : null;
  const targets = permsPlan(cfg, only);
  if (args.includes('--apply')) {
    const { applied, notApplied, allApplied } = permsApply(targets);
    if (!only && allApplied) {
      cfg.permissions_confirmed = true;
      writeFileSync(resolve(moduleDir, 'project.json'), JSON.stringify(cfg, null, 2) + '\n');
    }
    out({ ok: true, applied, notApplied, permissions_confirmed: cfg.permissions_confirmed });
  }
  out({
    ok: true,
    targets: targets.map(({ current, proposalAllow, proposalDeny, ...t }) => t),
    hint: 'Review addAllow/addDeny, settingsDiff, relativeRules, dockerWarning and problem, then run again with --apply (backups are created). Relative rules are never changed by the module: fix them by hand. A target with problem is not written.',
  });
}

function cmdCheckOutput() {
  const file = args[0];
  if (!file || !existsSync(file)) out({ ok: false, reasons: ['log file not found'] }, 2);
  const r = checkToolOutput(readFileSync(file, 'utf8'));
  out(r, r.ok ? 0 : 1);
}

function copyModule(from, to) {
  cpSync(from, to, {
    recursive: true,
    filter: (s) => {
      const rel = relative(from, s).split(sep).join('/');
      return rel !== 'project.json' && !rel.startsWith('.work');
    },
  });
}

function moduleVersion(dir) {
  const f = resolve(dir, 'VERSION');
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : '0.0.0';
}

/** Copy a clean module (without this project's project.json) into another project. */
function cmdExport() {
  const dest = args.find((a) => !a.startsWith('--'));
  if (!dest) out({ ok: false, errors: ['usage: export <target-project-dir> [--force]'] }, 2);
  const target = resolve(dest, '.agents/delivery');
  if (existsSync(target) && !args.includes('--force')) {
    out({ ok: false, errors: ['target already has .agents/delivery: run upgrade there, or pass --force'] }, 1);
  }
  copyModule(moduleDir, target);
  out({
    ok: true, copied: target, version: moduleVersion(moduleDir),
    next: [`cd ${resolve(dest)}`, 'node .agents/delivery/delivery.mjs install', 'open Claude Code and run /deliver <task>'],
  });
}

/**
 * Add keys that newer module versions expect, never overwrite existing values.
 * One safety exception: an agy command without --app_data_dir gets this project's own profile,
 * so delivery stops sharing the global agy settings of interactive sessions.
 */
function cmdMigrateConfig() {
  const file = resolve(moduleDir, 'project.json');
  const cfg = readJson(file);
  if (!cfg) out({ ok: false, errors: ['project.json missing'] }, 1);
  const draft = buildDraft(detect());
  const added = [];
  for (const [k, v] of Object.entries(draft)) {
    if (k === 'unresolved' || k === 'configured') continue;
    if (!(k in cfg)) { cfg[k] = v; added.push(k); }
  }
  const changed = [];
  const agyCmd = cfg.commands?.antigravity;
  const agyFixed = withAgyProfile(agyCmd, agyProfileName(cfg.project ?? draft.project));
  if (agyFixed !== agyCmd) {
    cfg.commands.antigravity = agyFixed;
    changed.push('commands.antigravity');
  }
  const prev = cfg.module_version;
  cfg.module_version = moduleVersion(moduleDir);
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  out({ ok: true, previous: prev ?? null, version: cfg.module_version, added, changed });
}

/** Run inside the target project: upgrade this module from a newer copy, keeping project.json. */
function cmdUpgrade() {
  const given = args.find((a) => !a.startsWith('--'));
  if (!given) out({ ok: false, errors: ['usage: upgrade <path to newer .agents/delivery or to a project that has it>'] }, 2);
  let src = resolve(given);
  if (!existsSync(resolve(src, 'delivery.mjs')) && existsSync(resolve(src, '.agents/delivery/delivery.mjs'))) {
    src = resolve(src, '.agents/delivery');
  }
  if (!existsSync(resolve(src, 'delivery.mjs'))) out({ ok: false, errors: ['no delivery module found at the given path'] }, 1);
  if (src === moduleDir) out({ ok: false, errors: ['source and target are the same module'] }, 1);
  const from = moduleVersion(moduleDir);
  const to = moduleVersion(src);
  copyModule(src, moduleDir);
  const run = (a) => spawnSync(process.execPath, [resolve(moduleDir, 'delivery.mjs'), ...a], { encoding: 'utf8' });
  const migrated = existsSync(resolve(moduleDir, 'project.json')) ? run(['migrate-config']) : null;
  const installed = run(['install']);
  const parse = (r) => { try { return JSON.parse(r.stdout); } catch { return { raw: (r?.stdout ?? '') + (r?.stderr ?? '') }; } };
  out({ ok: installed.status === 0, from, to, migrated: migrated ? parse(migrated) : 'no project.json', install: parse(installed) }, installed.status === 0 ? 0 : 1);
}

async function cmdSelftest() {
  const { selftest } = await import('./lib/selftest.mjs');
  const r = selftest();
  out({ ok: r.ok, total: r.total, failed: r.failed.map((f) => `${f.name}: ${f.detail}`), results: args.includes('--verbose') ? r.results : undefined }, r.ok ? 0 : 1);
}

const commands = {
  export: cmdExport,
  upgrade: cmdUpgrade,
  'migrate-config': cmdMigrateConfig,
  selftest: cmdSelftest,
  doctor: cmdDoctor,
  perms: cmdPerms,
  'check-output': cmdCheckOutput,
  config: cmdConfig,
  detect: cmdDetect,
  'init-config': cmdInitConfig,
  validate: cmdValidate,
  'lock-tests': cmdLockTests,
  guard: cmdGuard,
  install: cmdInstall,
};

if (!commands[cmd] || !SUBCOMMANDS.includes(cmd)) {
  out({ ok: false, errors: [`usage: ${Object.keys(commands).join(' | ')}`] }, 2);
}
commands[cmd]();
