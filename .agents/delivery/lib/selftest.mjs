// Self-test: builds throwaway fixture projects, copies this module into each (as a user would),
// and checks detection, installation, config, permissions planning, guards and failure detection.
// Spends no tokens and calls no AI tool.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { moduleDir, root, toPosix } from './util.mjs';
import * as detectMod from './detect.mjs';
import * as toolsMod from './tools.mjs';
const { proposeRoles, checkToolOutput } = toolsMod;

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });
let activeEnv = {};

function sh(cmd, args, cwd, extraEnv = {}) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...activeEnv, ...extraEnv } });
}

function cli(dir, ...args) {
  return cliEnv(dir, {}, ...args);
}

function cliEnv(dir, extraEnv, ...args) {
  const r = sh('node', [resolve(dir, '.agents/delivery/delivery.mjs'), ...args], dir, extraEnv);
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { code: r.status, json, raw: r.stdout + r.stderr };
}

function fixture(base, name, files, { commit = false } = {}) {
  const dir = resolve(base, name);
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(resolve(dir, f)), { recursive: true });
    writeFileSync(resolve(dir, f), c);
  }
  mkdirSync(dir, { recursive: true });
  sh('git', ['init', '-q', '-b', 'main'], dir);
  cpSync(moduleDir, resolve(dir, '.agents/delivery'), {
    recursive: true,
    filter: (s) => !/[\\/]project\.json$/.test(s) && !/[\\/]\.work([\\/]|$)/.test(s),
  });
  if (commit) {
    sh('git', ['add', '-A'], dir);
    sh('git', ['-c', 'user.name=selftest', '-c', 'user.email=selftest@example.com', 'commit', '-q', '-m', 'init'], dir);
  }
  return dir;
}

export function selftest() {
  const base = mkdtempSync(resolve(tmpdir(), 'delivery-selftest-'));
  const fakeHome = resolve(base, 'fake-home');
  mkdirSync(fakeHome, { recursive: true });
  const defaultAgyFile = resolve(fakeHome, '.gemini/antigravity-cli/settings.json');
  const prevAgyEnv = process.env.DELIVERY_AGY_SETTINGS;
  process.env.DELIVERY_AGY_SETTINGS = defaultAgyFile;
  activeEnv = { HOME: fakeHome, USERPROFILE: fakeHome, DELIVERY_AGY_SETTINGS: defaultAgyFile };
  try {
    const cases = [
      ['node', { 'package.json': JSON.stringify({ name: 'shop', scripts: { test: 'jest' }, devDependencies: { jest: '1' } }), 'src/a.js': '', 'tests/a.test.js': '' },
        { profile: 'node', file: 'npx jest {path}' }],
      ['python', { 'pyproject.toml': '[project]\nname = "svc"\ndependencies = ["pytest"]\n', 'app/main.py': '', 'tests/test_a.py': '' },
        { profile: 'python', file: 'python -m pytest {path} -q' }],
      ['laravel', { 'composer.json': JSON.stringify({ name: 'a/b', require: { 'laravel/framework': '11' } }), artisan: '', 'app/M.php': '', 'tests/T.php': '' },
        { profile: 'laravel', file: 'php artisan test {path}' }],
      ['yii2', { 'composer.json': JSON.stringify({ name: 'a/y', require: { 'yiisoft/yii2': '2' }, 'require-dev': { 'codeception/codeception': '5' } }), yii: '', 'src/x.php': '' },
        { profile: 'yii2', file: 'php vendor/bin/codecept run {suite} {path} --no-colors' }],
      ['empty', {}, { profile: 'generic', file: null, empty: true }],
    ];

    for (const [name, files, expect] of cases) {
      const dir = fixture(base, name, files);
      const inst = cli(dir, 'install');
      check(`${name}: install`, inst.code === 0 && inst.json?.ok, inst.raw.slice(0, 300));
      const det = cli(dir, 'detect').json?.detected;
      check(`${name}: profile ${expect.profile}`, det?.profile === expect.profile, det?.profile);
      check(`${name}: test command`, (det?.testCommands?.file ?? null) === expect.file, det?.testCommands?.file);
      if (expect.empty) check(`${name}: greenfield flag`, det?.empty === true);
      const cfg = cli(dir, 'config');
      check(`${name}: config valid`, cfg.json?.ok && cfg.json.configured === false, cfg.raw.slice(0, 300));
      check(`${name}: asks language`, (cfg.json?.unresolved ?? []).some((u) => u.key === 'language'));
      check(`${name}: skills installed`, cli(dir, 'install', '--check').code === 0);
      check(`${name}: both skill dirs`, existsSync(resolve(dir, '.claude/skills/deliver/SKILL.md')) && existsSync(resolve(dir, '.agents/skills/deliver/SKILL.md')));
      const perms = cli(dir, 'perms').json;
      check(`${name}: perms plan`, (perms?.targets ?? []).some((t) => t.tool === 'claude' && t.addAllow.length > 0));
      rmSync(dir, { recursive: true, force: true });
    }

    // Guards on a committed project.
    const dir = fixture(base, 'guards', {
      'package.json': JSON.stringify({ name: 'g' }), 'src/app.js': 'a\n', 'tests/.keep': '', '.gitignore': '.work/\n',
    }, { commit: true });
    cli(dir, 'install');
    const cfgFile = resolve(dir, '.agents/delivery/project.json');
    const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
    cfg.configured = true; cfg.language = 'en'; cfg.base_branch = 'main';
    writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
    const task = resolve(dir, '.work/tasks/T1');
    mkdirSync(task, { recursive: true });
    writeFileSync(resolve(dir, 'tests/a.test.js'), 'test\n');
    check('guards: lock-tests', cli(dir, 'lock-tests', task).json?.locked?.includes('tests/a.test.js'));
    writeFileSync(resolve(dir, 'tests/a.test.js'), 'test\r\n');
    check('guards: CRLF is not a change', cli(dir, 'guard', task).code === 0);
    writeFileSync(resolve(dir, 'tests/a.test.js'), 'changed\n');
    check('guards: edited locked test is caught', cli(dir, 'guard', task).code === 1);
    writeFileSync(resolve(dir, 'tests/a.test.js'), 'test\n');
    writeFileSync(resolve(dir, '.env'), 'SECRET=1\n');
    check('guards: forbidden path is caught', /forbidden path/.test(cli(dir, 'guard', task).raw));
    rmSync(resolve(dir, '.env'));
    writeFileSync(resolve(dir, 'src/app.js'), 'b\n');
    check('guards: --tests-only catches code edit', /non-test file/.test(cli(dir, 'guard', task, '--tests-only').raw));

    // Export into a fresh project, then upgrade an older copy and keep its project.json.
    const fresh = resolve(base, 'export-target');
    mkdirSync(fresh, { recursive: true });
    const exp = cli(dir, 'export', fresh);
    check('export: copies module', exp.code === 0 && existsSync(resolve(fresh, '.agents/delivery/delivery.mjs')));
    check('export: leaves project.json behind', !existsSync(resolve(fresh, '.agents/delivery/project.json')));
    check('export: refuses to overwrite', cli(dir, 'export', fresh).code === 1);
    check('export: installs in target', cli(fresh, 'install').code === 0);
    const oldCfgFile = resolve(fresh, '.agents/delivery/project.json');
    const oldCfg = JSON.parse(readFileSync(oldCfgFile, 'utf8'));
    delete oldCfg.roles_confirmed; delete oldCfg.permissions_confirmed;
    oldCfg.module_version = '0.1.0'; oldCfg.language = 'uk'; oldCfg.configured = true;
    writeFileSync(oldCfgFile, JSON.stringify(oldCfg, null, 2));
    writeFileSync(resolve(fresh, '.agents/delivery/VERSION'), '0.1.0\n');
    const upg = cli(fresh, 'upgrade', dir);
    check('upgrade: ok', upg.code === 0 && upg.json?.ok, upg.raw.slice(0, 300));
    const upgraded = JSON.parse(readFileSync(oldCfgFile, 'utf8'));
    check('upgrade: keeps project values', upgraded.language === 'uk' && upgraded.configured === true);
    check('upgrade: adds new keys and version', 'roles_confirmed' in upgraded && upgraded.module_version === readFileSync(resolve(moduleDir, 'VERSION'), 'utf8').trim());

    // Schemas.
    const good = resolve(base, 'triage-good.json');
    writeFileSync(good, JSON.stringify({ sufficient: true, missing: [], track: 'S', architect_triggers: [], risks: [], needs_human_approval: [], estimate_files: 1 }));
    const bad = resolve(base, 'triage-bad.json');
    writeFileSync(bad, JSON.stringify({ sufficient: 'yes', track: 'X' }));
    check('schema: valid triage', cli(dir, 'validate', 'triage', good).code === 0);
    check('schema: invalid triage', cli(dir, 'validate', 'triage', bad).code === 1);

    // Role remapping and silent-failure detection (pure functions).
    const pref = { ba: 'claude', teamlead: 'claude', architect: 'claude', qa_design: 'antigravity', dev: 'codex', review: 'claude', qa_run: 'antigravity', report: 'claude' };
    const tools = (c, x, a) => ({ claude: { found: c }, codex: { found: x }, antigravity: { found: a } });
    const noCodex = proposeRoles(pref, tools(true, false, true));
    check('roles: no codex -> dev claude, review antigravity', noCodex.roles.dev === 'claude' && noCodex.roles.review === 'antigravity');
    const onlyClaude = proposeRoles(pref, tools(true, false, false));
    check('roles: single tool -> weak independence flagged', onlyClaude.weakIndependence === true && onlyClaude.warnings.length === 1);
    check('output: detects agy auto-deny', !checkToolOutput('jetski: no output produced ... auto-denied {"response":""}').ok);
    check('output: accepts normal output', checkToolOutput('{"status":"SUCCESS","response":"done"}').ok);

    const allRoles = ['ba', 'teamlead', 'architect', 'qa_design', 'dev', 'review', 'qa_run', 'report'];
    const allFound = tools(true, true, true);
    const canon = (t) => (t === 'gemini' ? 'antigravity' : t);

    const subsetPlan = proposeRoles(pref, allFound, ['claude', 'codex']);
    check('ac1: tools_enabled restricts available and roles',
      subsetPlan.available.length === 2
      && subsetPlan.available.includes('claude')
      && subsetPlan.available.includes('codex')
      && allRoles.every((r) => ['claude', 'codex'].includes(subsetPlan.roles?.[r])),
      JSON.stringify(subsetPlan));

    const defaultPlan = proposeRoles(pref, tools(true, false, true));
    check('ac2: unset tools_enabled uses all found tools with full independence',
      defaultPlan.available.length === 2
      && defaultPlan.roles?.dev === 'claude'
      && defaultPlan.roles?.review === 'antigravity'
      && defaultPlan.roles?.qa_design === 'antigravity'
      && defaultPlan.roles?.qa_run === 'antigravity'
      && Array.isArray(defaultPlan.weakRoles) && defaultPlan.weakRoles.length === 0,
      JSON.stringify(defaultPlan));

    const missingToolPlan = proposeRoles(pref, tools(true, false, true), ['claude', 'codex']);
    check('ac3: tools_enabled with missing tool reports problem',
      Array.isArray(missingToolPlan.problems)
      && missingToolPlan.problems.some((p) => /codex/i.test(p)),
      JSON.stringify(missingToolPlan));

    const emptySetPlan = proposeRoles(pref, allFound, []);
    check('ac3: empty tools_enabled reports problem and no available tools',
      emptySetPlan.available.length === 0
      && Array.isArray(emptySetPlan.problems)
      && emptySetPlan.problems.length > 0,
      JSON.stringify(emptySetPlan));

    const combos = [
      ['claude', ['claude'], true],
      ['codex', ['codex'], true],
      ['gemini', ['gemini'], true],
      ['claude+codex', ['claude', 'codex'], false],
      ['gemini+claude', ['gemini', 'claude'], false],
      ['gemini+codex', ['gemini', 'codex'], false],
      ['claude+codex+gemini', ['claude', 'codex', 'gemini'], false],
    ];
    for (const [label, enabled, expectWeak] of combos) {
      const expectedTools = enabled.map(canon);
      const p = proposeRoles(pref, allFound, enabled);
      const assigned = allRoles.map((r) => p.roles?.[r]);
      const allAssignedInSet = assigned.every((t) => expectedTools.includes(t));
      const allEnabledUsed = expectedTools.every((t) => assigned.includes(t));
      const separated = expectWeak
        ? assigned.every((t) => t === expectedTools[0])
        : (p.roles?.review !== p.roles?.dev && p.roles?.qa_design !== p.roles?.dev && p.roles?.qa_run !== p.roles?.dev);
      const weakOk = expectWeak
        ? (p.weakIndependence === true
          && Array.isArray(p.weakRoles)
          && ['review', 'qa_design', 'qa_run'].every((r) => p.weakRoles.includes(r))
          && Array.isArray(p.mitigations) && p.mitigations.length >= 4)
        : (p.weakIndependence === false
          && Array.isArray(p.weakRoles) && p.weakRoles.length === 0
          && Array.isArray(p.mitigations) && p.mitigations.length === 0);
      check(`combo ${label}: roles, coverage and independence`,
        allAssignedInSet && allEnabledUsed && separated && weakOk,
        JSON.stringify(p));
    }

    const qaConflictPref = { ...pref, dev: 'codex', review: 'claude', qa_design: 'codex', qa_run: 'codex' };
    const qaSeparated = proposeRoles(qaConflictPref, allFound, ['claude', 'codex']);
    check('ac15: qa_design and qa_run separated from dev when possible',
      qaSeparated.roles?.dev === 'codex'
      && qaSeparated.roles?.qa_design === 'claude'
      && qaSeparated.roles?.qa_run === 'claude'
      && qaSeparated.weakIndependence === false,
      JSON.stringify(qaSeparated));

    const epDir = fixture(base, 'entrypoints', { 'package.json': JSON.stringify({ name: 'ep' }) });
    cli(epDir, 'install');
    const epAll = toolsMod.checkEntryPoints?.(epDir, ['claude', 'codex', 'gemini']);
    check('ac7-ac8: entry points present for all tools', epAll?.ok === true && epAll?.missing?.length === 0, JSON.stringify(epAll));
    rmSync(resolve(epDir, '.claude/skills/deliver/SKILL.md'), { force: true });
    const epNoClaudeConductor = toolsMod.checkEntryPoints?.(epDir, ['codex', 'gemini']);
    check('ac7: codex and gemini entry points valid without .claude/skills', epNoClaudeConductor?.ok === true, JSON.stringify(epNoClaudeConductor));
    const epMissingClaude = toolsMod.checkEntryPoints?.(epDir, ['claude']);
    check('ac8: missing claude entry point detected', epMissingClaude?.ok === false && epMissingClaude?.missing?.length > 0, JSON.stringify(epMissingClaude));
    rmSync(resolve(epDir, '.agents/skills/deliver/SKILL.md'), { force: true });
    const epMissingAgents = toolsMod.checkEntryPoints?.(epDir, ['codex']);
    check('ac8: missing .agents/skills entry point detected for codex/gemini', epMissingAgents?.ok === false && epMissingAgents?.missing?.length > 0, JSON.stringify(epMissingAgents));

    const cmdHeadlessCodex = toolsMod.resolveCommand?.('claude', { ...cfg, tools_enabled: ['claude', 'codex'] }, { conductor: 'codex' });
    const cmdHeadlessGemini = toolsMod.resolveCommand?.('claude', { ...cfg, tools_enabled: ['gemini', 'claude'] }, { conductor: 'antigravity' });
    check('ac9: claude runs as headless claude -p under non-Claude conductor',
      typeof cmdHeadlessCodex === 'string' && /^claude\s+-p\b/.test(cmdHeadlessCodex) && cmdHeadlessCodex.includes('{prompt}')
      && typeof cmdHeadlessGemini === 'string' && /^claude\s+-p\b/.test(cmdHeadlessGemini),
      `${cmdHeadlessCodex} | ${cmdHeadlessGemini}`);
    const cmdSubagent = toolsMod.resolveCommand?.('claude', cfg, { conductor: 'claude' });
    check('ac10: claude runs as subagent under Claude Code conductor', cmdSubagent === 'subagent', String(cmdSubagent));
    const cmdDisabledClaude = toolsMod.resolveCommand?.('claude', { ...cfg, tools_enabled: ['codex', 'gemini'] }, { conductor: 'codex' });
    check('ac11: disabled claude not resolved under non-Claude conductor', cmdDisabledClaude === null, String(cmdDisabledClaude));

    const indSingle = toolsMod.evaluateIndependence?.(onlyClaude.roles);
    check('ac13-ac16: single tool independence report lists review, qa_design, qa_run and mitigations',
      indSingle?.weakIndependence === true
      && ['review', 'qa_design', 'qa_run'].every((r) => indSingle?.weakRoles?.includes(r))
      && indSingle?.mitigations?.length >= 4
      && /weak independence/i.test(indSingle?.reportBadge ?? '')
      && ['review', 'qa_design', 'qa_run'].every((r) => (indSingle?.reportBadge ?? '').includes(r)),
      JSON.stringify(indSingle));

    const indPartial = toolsMod.evaluateIndependence?.({ ...pref, dev: 'codex', review: 'claude', qa_design: 'codex', qa_run: 'antigravity' });
    check('ac14-ac16: partial overlap flags only matching QA role with mitigations',
      indPartial?.weakIndependence === true
      && indPartial?.weakRoles?.length === 1 && indPartial?.weakRoles?.[0] === 'qa_design'
      && /weak independence/i.test(indPartial?.reportBadge ?? '')
      && (indPartial?.reportBadge ?? '').includes('qa_design')
      && !(indPartial?.reportBadge ?? '').includes('review'),
      JSON.stringify(indPartial));

    const indFull = toolsMod.evaluateIndependence?.(pref);
    check('ac12-ac17: full independence has no weak independence marker',
      indFull?.weakIndependence === false
      && indFull?.weakRoles?.length === 0
      && (indFull?.reportBadge ?? null) === '',
      JSON.stringify(indFull));

    const cfgDir = resolve(epDir, '.agents/delivery/project.json');
    cli(epDir, 'install');
    const baseEpCfg = JSON.parse(readFileSync(cfgDir, 'utf8'));
    baseEpCfg.configured = true; baseEpCfg.language = 'uk'; baseEpCfg.base_branch = 'main';
    baseEpCfg.test.commands.file = 'node --test {path}';

    writeFileSync(cfgDir, JSON.stringify({ ...baseEpCfg, tools_enabled: [] }, null, 2));
    const emptyCfgRes = cli(epDir, 'config');
    check('ac3: config command rejects empty tools_enabled',
      emptyCfgRes.code === 1 && (emptyCfgRes.json?.errors ?? []).some((e) => /tools_enabled/i.test(e)),
      emptyCfgRes.raw);

    const singleClaudeRoles = Object.fromEntries(allRoles.map((r) => [r, 'claude']));
    writeFileSync(cfgDir, JSON.stringify({ ...baseEpCfg, tools_enabled: ['claude'], roles: singleClaudeRoles }, null, 2));
    const singleCfgRes = cli(epDir, 'config');
    check('ac4-ac13: config command accepts single enabled tool with dev == review', singleCfgRes.code === 0 && singleCfgRes.json?.ok === true, singleCfgRes.raw);

    writeFileSync(cfgDir, JSON.stringify({ ...baseEpCfg, tools_enabled: ['claude', 'codex'], roles: { ...pref, qa_design: 'antigravity', qa_run: 'claude' } }, null, 2));
    const disabledRoleRes = cli(epDir, 'config');
    check('ac6: config command rejects manual role assigned to disabled tool',
      disabledRoleRes.code === 1
      && (disabledRoleRes.json?.errors ?? []).some((e) => e.includes('qa_design') && e.includes('antigravity')),
      disabledRoleRes.raw);

    const validPairRoles = { ba: 'claude', teamlead: 'claude', architect: 'claude', qa_design: 'claude', dev: 'codex', review: 'claude', qa_run: 'claude', report: 'claude' };
    writeFileSync(cfgDir, JSON.stringify({ ...baseEpCfg, tools_enabled: ['claude', 'codex'], roles: validPairRoles, roles_confirmed: true }, null, 2));
    const legacySigRes = cli(epDir, 'config');
    const afterLegacyCfg = JSON.parse(readFileSync(cfgDir, 'utf8'));
    check('ac20: roles_confirmed without signature resets once without crash',
      legacySigRes.code === 0 && legacySigRes.json?.ok === true && afterLegacyCfg.roles_confirmed === false,
      `${legacySigRes.raw} :: ${JSON.stringify(afterLegacyCfg)}`);

    const sig = toolsMod.rolesSignature?.({ tools_enabled: ['claude', 'codex'], roles: validPairRoles });
    writeFileSync(cfgDir, JSON.stringify({ ...baseEpCfg, tools_enabled: ['claude', 'codex'], roles: validPairRoles, roles_confirmed: true, roles_signature: sig ?? 'missing' }, null, 2));
    const validSigRes = cli(epDir, 'config');
    const afterValidSigCfg = JSON.parse(readFileSync(cfgDir, 'utf8'));
    check('ac18: matching roles_signature keeps roles_confirmed true',
      typeof sig === 'string' && sig.length > 0 && validSigRes.code === 0 && afterValidSigCfg.roles_confirmed === true,
      JSON.stringify(afterValidSigCfg));

    writeFileSync(cfgDir, JSON.stringify({ ...baseEpCfg, tools_enabled: ['claude', 'codex', 'gemini'], roles: validPairRoles, roles_confirmed: true, roles_signature: sig ?? 'missing' }, null, 2));
    cli(epDir, 'config');
    const afterToolsChangeCfg = JSON.parse(readFileSync(cfgDir, 'utf8'));
    check('ac19: changing tools_enabled resets roles_confirmed',
      typeof sig === 'string' && afterToolsChangeCfg.roles_confirmed === false,
      JSON.stringify(afterToolsChangeCfg));

    writeFileSync(cfgDir, JSON.stringify({ ...baseEpCfg, tools_enabled: ['claude', 'codex'], roles: { ...validPairRoles, ba: 'codex' }, roles_confirmed: true, roles_signature: sig ?? 'missing' }, null, 2));
    cli(epDir, 'config');
    const afterRoleChangeCfg = JSON.parse(readFileSync(cfgDir, 'utf8'));
    check('ac19: changing role map resets roles_confirmed',
      typeof sig === 'string' && afterRoleChangeCfg.roles_confirmed === false,
      JSON.stringify(afterRoleChangeCfg));

    const permsOnlyClaude = toolsMod.proposePermissions({ ...cfg, roles: singleClaudeRoles }, singleClaudeRoles);
    check('ac21: permissions for claude-only omit antigravity, codex exec and agy -p',
      'claude' in permsOnlyClaude
      && !('antigravity' in permsOnlyClaude)
      && !permsOnlyClaude.claude.allow.some((r) => /codex exec|agy -p/.test(r)),
      JSON.stringify(permsOnlyClaude));

    const permsClaudeCodex = toolsMod.proposePermissions({ ...cfg, roles: validPairRoles }, validPairRoles);
    check('ac21: permissions for claude+codex include codex exec but omit antigravity and agy -p',
      'claude' in permsClaudeCodex
      && !('antigravity' in permsClaudeCodex)
      && permsClaudeCodex.claude.allow.includes('Bash(codex exec:*)')
      && !permsClaudeCodex.claude.allow.some((r) => /agy -p/.test(r)),
      JSON.stringify(permsClaudeCodex));

    const rootPosix = toPosix(root);
    const codexAgyRoles = { ba: 'antigravity', teamlead: 'antigravity', architect: 'antigravity', qa_design: 'antigravity', dev: 'codex', review: 'antigravity', qa_run: 'antigravity', report: 'antigravity' };
    const permsCodexAgy = toolsMod.proposePermissions({ ...cfg, code_dirs: ['src/'], test_dirs: ['tests/'], roles: codexAgyRoles }, codexAgyRoles);
    check('ac21: permissions for codex+gemini omit claude and do not grant code_dirs write when agy is not dev',
      !('claude' in permsCodexAgy)
      && 'antigravity' in permsCodexAgy
      && permsCodexAgy.antigravity.allow.includes(`write_file(${rootPosix}/tests/)`)
      && permsCodexAgy.antigravity.allow.includes(`write_file(${rootPosix}/.work/)`)
      && !permsCodexAgy.antigravity.allow.includes(`write_file(${rootPosix}/src/)`),
      JSON.stringify(permsCodexAgy));

    const onlyAgyRoles = Object.fromEntries(allRoles.map((r) => [r, 'antigravity']));
    const permsOnlyAgy = toolsMod.proposePermissions({ ...cfg, code_dirs: ['src/'], test_dirs: ['tests/'], roles: onlyAgyRoles }, onlyAgyRoles);
    check('ac21: permissions for gemini-only grant write_file on code_dirs because agy is dev',
      !('claude' in permsOnlyAgy)
      && 'antigravity' in permsOnlyAgy
      && permsOnlyAgy.antigravity.allow.includes(`write_file(${rootPosix}/src/)`)
      && permsOnlyAgy.antigravity.allow.includes(`write_file(${rootPosix}/tests/)`)
      && permsOnlyAgy.antigravity.allow.includes(`write_file(${rootPosix}/.work/)`),
      JSON.stringify(permsOnlyAgy));

    const readmeText = readFileSync(resolve(moduleDir, 'README.md'), 'utf8');
    const deliverRoleText = readFileSync(resolve(moduleDir, 'roles/deliver.md'), 'utf8');
    const reportRoleText = readFileSync(resolve(moduleDir, 'roles/report.md'), 'utf8');
    check('ac23: README documents tools_enabled, 7 combinations, claude -p, weak independence and signature reset',
      readmeText.includes('tools_enabled')
      && readmeText.includes('claude -p')
      && /weak independence/i.test(readmeText)
      && /roles_confirmed|roles_signature/.test(readmeText),
      'missing required sections in README.md');
    check('ac7-ac9-ac16: deliver.md and report.md document claude -p and weak independence',
      deliverRoleText.includes('claude -p')
      && /weak independence/i.test(reportRoleText),
      'missing claude -p or weak independence in role docs');

    const beforeBadCfg = JSON.stringify({ ...baseEpCfg, tools_enabled: [], roles: validPairRoles, roles_confirmed: true, permissions_confirmed: true }, null, 2) + '\n';
    writeFileSync(cfgDir, beforeBadCfg);
    const badCfgNoWriteRes = cli(epDir, 'config');
    const afterBadCfgRaw = readFileSync(cfgDir, 'utf8');
    const afterBadCfg = JSON.parse(afterBadCfgRaw);
    check('ac24: config does not rewrite project.json when errors exist',
      badCfgNoWriteRes.code === 1
      && afterBadCfg.roles_confirmed === true
      && afterBadCfg.permissions_confirmed === true
      && afterBadCfgRaw === beforeBadCfg,
      `${badCfgNoWriteRes.raw} :: ${afterBadCfgRaw}`);

    writeFileSync(cfgDir, JSON.stringify({ ...baseEpCfg, tools_enabled: ['claude', 'codex'], roles: validPairRoles, roles_confirmed: true, permissions_confirmed: true }, null, 2) + '\n');
    const firstResetRes = cli(epDir, 'config');
    const afterFirstResetRaw = readFileSync(cfgDir, 'utf8');
    const afterFirstResetCfg = JSON.parse(afterFirstResetRaw);
    const secondResetRes = cli(epDir, 'config');
    const afterSecondResetRaw = readFileSync(cfgDir, 'utf8');
    check('ac24: valid config resets confirmations once with reset list and second run does not write',
      firstResetRes.code === 0
      && Array.isArray(firstResetRes.json?.reset)
      && firstResetRes.json.reset.includes('roles_confirmed')
      && firstResetRes.json.reset.includes('permissions_confirmed')
      && afterFirstResetCfg.roles_confirmed === false
      && afterFirstResetCfg.permissions_confirmed === false
      && secondResetRes.code === 0
      && Array.isArray(secondResetRes.json?.reset)
      && secondResetRes.json.reset.length === 0
      && afterSecondResetRaw === afterFirstResetRaw,
      `${firstResetRes.raw} :: ${secondResetRes.raw}`);

    const onlyCodexRoles = Object.fromEntries(allRoles.map((r) => [r, 'codex']));
    const permsCondBoth = toolsMod.proposePermissions(
      { ...cfg, conductor: 'claude', tools_enabled: ['codex', 'antigravity'], roles: codexAgyRoles },
      codexAgyRoles,
      { conductor: 'claude' },
    );
    const permsCondCodexOnly = toolsMod.proposePermissions(
      { ...cfg, conductor: 'claude', tools_enabled: ['codex'], roles: onlyCodexRoles },
      onlyCodexRoles,
      { conductor: 'claude' },
    );
    const permsNonClaudeCond = toolsMod.proposePermissions(
      { ...cfg, conductor: 'codex', tools_enabled: ['codex', 'antigravity'], roles: codexAgyRoles },
      codexAgyRoles,
      { conductor: 'codex' },
    );
    check('ac25: claude conductor gets codex and agy bash permissions even without claude role',
      'claude' in permsCondBoth
      && permsCondBoth.claude.allow.includes('Bash(codex exec:*)')
      && permsCondBoth.claude.allow.includes('Bash(agy -p:*)')
      && 'claude' in permsCondCodexOnly
      && permsCondCodexOnly.claude.allow.includes('Bash(codex exec:*)')
      && !permsCondCodexOnly.claude.allow.some((r) => /agy -p/.test(r))
      && !('claude' in permsNonClaudeCond),
      JSON.stringify({ permsCondBoth, permsCondCodexOnly, permsNonClaudeCond }));

    writeFileSync(cfgDir, JSON.stringify({
      ...baseEpCfg,
      tools_enabled: ['claude', 'codex', 'gemini'],
      roles: { ...validPairRoles, qa_design: 'gemini', qa_run: 'antigravity' },
    }, null, 2));
    const geminiAliasRes = cli(epDir, 'config');
    check('ac26: config canonicalizes gemini in roles and tools_enabled to antigravity',
      geminiAliasRes.code === 0 && geminiAliasRes.json?.ok === true && (geminiAliasRes.json?.errors ?? []).length === 0,
      geminiAliasRes.raw);

    const agyMatchesRule = (rules, cmdLine) => (rules ?? []).some((rule) => {
      if (rule.startsWith('command(regex:') && rule.endsWith(')')) {
        const pat = rule.slice('command(regex:'.length, -1);
        try { return new RegExp(`^${pat}$`).test(cmdLine); } catch { return false; }
      }
      if (rule.startsWith('command(') && rule.endsWith(')')) {
        const p = rule.slice('command('.length, -1);
        return cmdLine === p || cmdLine.startsWith(`${p} `);
      }
      return false;
    });
    const agySandboxOn = (p) => p?.settings?.toolPermission === 'proceed-in-sandbox'
      && p?.settings?.enableTerminalSandbox === true
      && !(p?.allow ?? []).some((r) => r.startsWith('command('));
    const agyAllowsCmd = (p, cmdLine) => agySandboxOn(p) && !agyMatchesRule(p?.deny, cmdLine);
    const permsAgySafeSub = toolsMod.proposePermissions({
      ...cfg,
      test: { ...cfg.test, commands: { file: 'npx jest {path}', suite: 'npx jest', lint: null } },
      roles: codexAgyRoles,
    }, codexAgyRoles);
    const safeSubs = ['validate', 'guard', 'check-output', 'detect', 'selftest'];
    const unsafeSubs = ['lock-tests', 'install', 'config', 'doctor', 'perms'];
    check('ac27: antigravity permissions allow safe delivery.mjs subcommands and block mutating ones',
      safeSubs.every((sub) => agyAllowsCmd(permsAgySafeSub.antigravity, `node .agents/delivery/delivery.mjs ${sub}`))
      && unsafeSubs.every((sub) => !agyAllowsCmd(permsAgySafeSub.antigravity, `node .agents/delivery/delivery.mjs ${sub}`)),
      JSON.stringify(permsAgySafeSub.antigravity));

    const permsFileTestDir = toolsMod.proposePermissions({
      ...cfg,
      code_dirs: ['src/'],
      test_dirs: ['.agents/delivery/lib/selftest.mjs', 'tests'],
      roles: codexAgyRoles,
    }, codexAgyRoles);
    check('ac28: write_file rule for single file in test_dirs has no trailing slash while directory keeps slash',
      permsFileTestDir.antigravity?.allow?.includes(`write_file(${rootPosix}/.agents/delivery/lib/selftest.mjs)`)
      && !permsFileTestDir.antigravity?.allow?.includes(`write_file(${rootPosix}/.agents/delivery/lib/selftest.mjs/)`)
      && permsFileTestDir.antigravity?.allow?.includes(`write_file(${rootPosix}/tests/)`),
      JSON.stringify(permsFileTestDir.antigravity));

    const protPlan = proposeRoles(pref, allFound, ['claude', 'codex', 'antigravity'], {
      code_dirs: ['.agents/delivery/'],
      test_dirs: ['.agents/delivery/lib/selftest.mjs'],
    });
    const protQaPlan = proposeRoles({ ...pref, dev: 'claude', qa_design: 'codex' }, allFound, ['claude', 'codex', 'antigravity'], {
      code_dirs: ['src/'],
      test_dirs: ['.agents/delivery/lib/selftest.mjs'],
    });
    const protMsgs = [...(protPlan.warnings ?? []), ...(protPlan.problems ?? [])];
    const protQaMsgs = [...(protQaPlan.warnings ?? []), ...(protQaPlan.problems ?? [])];
    check('ac29: proposeRoles switches codex away from protected_paths (.agents/.git) when alternative exists',
      protPlan.roles?.dev !== 'codex'
      && protPlan.roles?.qa_design !== 'codex'
      && protPlan.roles?.review !== protPlan.roles?.dev
      && protPlan.roles?.qa_design !== protPlan.roles?.dev
      && protPlan.roles?.qa_run !== protPlan.roles?.dev
      && protMsgs.some((m) => /protected_paths/i.test(m))
      && protQaPlan.roles?.qa_design !== 'codex'
      && protQaPlan.roles?.qa_design !== protQaPlan.roles?.dev
      && protQaMsgs.some((m) => /protected_paths/i.test(m)),
      JSON.stringify({ protPlan, protQaPlan }));

    const protOnlyCodex = proposeRoles(pref, allFound, ['codex'], {
      code_dirs: ['.agents/delivery/'],
      test_dirs: ['tests/'],
    });
    const protOnlyCodexMsgs = [...(protOnlyCodex.warnings ?? []), ...(protOnlyCodex.problems ?? [])];
    check('ac29: proposeRoles keeps codex with protected_paths warning and patch protocol when only codex is available',
      protOnlyCodex.roles?.dev === 'codex'
      && protOnlyCodexMsgs.some((m) => /protected_paths/i.test(m))
      && protOnlyCodexMsgs.some((m) => /patch/i.test(m)),
      JSON.stringify(protOnlyCodex));

    const devRoleText = readFileSync(resolve(moduleDir, 'roles/dev.md'), 'utf8');
    check('ac30: deliver.md, dev.md and README.md document codex sandbox limits, conductor commit and implementation.patch',
      deliverRoleText.includes('implementation.patch')
      && /codex/i.test(deliverRoleText)
      && /\.git/.test(deliverRoleText)
      && devRoleText.includes('implementation.patch')
      && /codex/i.test(devRoleText)
      && /\.git/.test(devRoleText)
      && /\.agents/.test(readmeText)
      && /\.git/.test(readmeText),
      'missing codex sandbox / implementation.patch protocol in deliver.md, dev.md or README.md');

    const outAccessDenied = checkToolOutput('error: Access denied while writing .agents/delivery/delivery.mjs');
    const outIndexLock = checkToolOutput("fatal: Unable to create '/repo/.git/index.lock': Permission denied");
    const outReadOnly = checkToolOutput('Error: EROFS: read-only file system, open .agents/delivery/lib/tools.mjs');
    check('ac31: checkToolOutput detects codex write failures (access denied, index.lock, read-only)',
      !outAccessDenied.ok && outAccessDenied.reasons.length > 0
      && !outIndexLock.ok && outIndexLock.reasons.length > 0
      && !outReadOnly.ok && outReadOnly.reasons.length > 0,
      JSON.stringify({ outAccessDenied, outIndexLock, outReadOnly }));

    // ---------------------------------------------------------------- T-20261021-2045 checks
    const targetRoles = {
      ba: 'claude',
      teamlead: 'claude',
      architect: 'antigravity',
      qa_design: 'antigravity',
      dev: 'codex',
      review: 'antigravity',
      qa_run: 'antigravity',
      report: 'claude',
    };
    const sameRoles = (a, b) => allRoles.every((r) => a?.[r] === b?.[r]);
    const getRecs = (planOrDoc) => planOrDoc?.recommendations ?? planOrDoc?.proposal?.recommendations;
    const hasRec = (recs, role, fromTool, toTool) => Array.isArray(recs) && recs.some((r) => {
      if (typeof r === 'string') {
        return new RegExp(`\\b${role}\\b`).test(r) && r.includes(fromTool) && r.includes(toTool) && /README/i.test(r);
      }
      if (r && typeof r === 'object') {
        const rRole = r.role;
        const rFrom = r.from ?? r.current;
        const rTo = r.to ?? r.target;
        return rRole === role && rFrom === fromTool && rTo === toTool && /README/i.test(JSON.stringify(r));
      }
      return false;
    });
    const hasAnyRecForRole = (recs, role) => Array.isArray(recs) && recs.some((r) => (
      typeof r === 'string' ? new RegExp(`\\b${role}\\b`).test(r) : r?.role === role
    ));

    // AC-1: new project.json (install, init-config --stdout, DEFAULT_ROLES) uses target map and roles_confirmed: false.
    const ac1Dir = fixture(base, 't2045-ac1', { 'package.json': JSON.stringify({ name: 'ac1' }) });
    const ac1Stdout = cli(ac1Dir, 'init-config', '--stdout').json;
    cli(ac1Dir, 'install');
    const ac1Installed = JSON.parse(readFileSync(resolve(ac1Dir, '.agents/delivery/project.json'), 'utf8'));
    check('t2045-ac1: new project.json and init-config --stdout use target role map with roles_confirmed false',
      sameRoles(detectMod.DEFAULT_ROLES, targetRoles)
      && sameRoles(ac1Stdout?.roles, targetRoles)
      && ac1Stdout?.roles_confirmed === false
      && sameRoles(ac1Installed?.roles, targetRoles)
      && ac1Installed?.roles_confirmed === false,
      JSON.stringify({ defaultRoles: detectMod.DEFAULT_ROLES, stdout: ac1Stdout?.roles, installed: ac1Installed?.roles }));

    // AC-2: target map with all 3 tools and unprotected dirs keeps target map, empty changes, weak_independence false, no recommendations.
    const ac2Plan = proposeRoles(detectMod.DEFAULT_ROLES, allFound, ['claude', 'codex', 'antigravity'], {
      code_dirs: ['src/'],
      test_dirs: ['tests/'],
    });
    const ac2Recs = getRecs(ac2Plan);
    check('t2045-ac2: target map with all 3 tools and unprotected dirs has empty changes, weakIndependence false and no recommendations',
      sameRoles(ac2Plan.roles, targetRoles)
      && ac2Plan.changes?.length === 0
      && ac2Plan.weakIndependence === false
      && Array.isArray(ac2Recs) && ac2Recs.length === 0,
      JSON.stringify(ac2Plan));

    // AC-3: without antigravity, architect, review, qa_design and qa_run move to claude while dev stays on codex.
    const ac3Unavail = proposeRoles(detectMod.DEFAULT_ROLES, tools(true, true, false), undefined, { code_dirs: ['src/'], test_dirs: ['tests/'] });
    const ac3Disabled = proposeRoles(detectMod.DEFAULT_ROLES, allFound, ['claude', 'codex'], { code_dirs: ['src/'], test_dirs: ['tests/'] });
    const ac3MovedRoles = ['architect', 'review', 'qa_design', 'qa_run'];
    const ac3Ok = [ac3Unavail, ac3Disabled].every((p) => (
      ac3MovedRoles.every((r) => p.roles?.[r] === 'claude' && p.changes?.some((c) => c.role === r && c.from === 'antigravity' && c.to === 'claude'))
      && p.roles?.dev === 'codex'
      && p.roles?.review !== p.roles?.dev
      && p.weakIndependence === false
    ));
    check('t2045-ac3: without antigravity, architect, review, qa_design and qa_run move to claude and record changes',
      ac3Ok,
      JSON.stringify({ ac3Unavail, ac3Disabled }));

    // AC-4: without claude, ba, teamlead and report move to antigravity while architect, review and QA stay on antigravity.
    const ac4Unavail = proposeRoles(detectMod.DEFAULT_ROLES, tools(false, true, true), undefined, { code_dirs: ['src/'], test_dirs: ['tests/'] });
    const ac4Disabled = proposeRoles(detectMod.DEFAULT_ROLES, allFound, ['antigravity', 'codex'], { code_dirs: ['src/'], test_dirs: ['tests/'] });
    const ac4Ok = [ac4Unavail, ac4Disabled].every((p) => (
      ['ba', 'teamlead', 'report'].every((r) => p.roles?.[r] === 'antigravity' && p.changes?.some((c) => c.role === r && c.from === 'claude' && c.to === 'antigravity'))
      && ['architect', 'review', 'qa_design', 'qa_run'].every((r) => p.roles?.[r] === 'antigravity' && !p.changes?.some((c) => c.role === r))
      && p.roles?.dev === 'codex'
      && p.weakIndependence === false
    ));
    check('t2045-ac4: without claude, ba, teamlead and report move to antigravity while architect, review and QA stay on antigravity',
      ac4Ok,
      JSON.stringify({ ac4Unavail, ac4Disabled }));

    // AC-5: without codex and with unprotected code_dirs, dev moves to claude while architect, review, qa_design and qa_run stay on antigravity.
    const ac5Unavail = proposeRoles(detectMod.DEFAULT_ROLES, tools(true, false, true), undefined, { code_dirs: ['src/'], test_dirs: ['tests/'] });
    const ac5Disabled = proposeRoles(detectMod.DEFAULT_ROLES, allFound, ['claude', 'antigravity'], { code_dirs: ['src/'], test_dirs: ['tests/'] });
    const ac5Ok = [ac5Unavail, ac5Disabled].every((p) => (
      p.roles?.dev === 'claude'
      && p.changes?.length === 1 && p.changes[0].role === 'dev' && p.changes[0].from === 'codex' && p.changes[0].to === 'claude'
      && ['architect', 'review', 'qa_design', 'qa_run'].every((r) => p.roles?.[r] === 'antigravity')
      && p.weakIndependence === false
    ));
    check('t2045-ac5: without codex and with unprotected code_dirs, dev moves to claude and review/QA stay on antigravity',
      ac5Ok,
      JSON.stringify({ ac5Unavail, ac5Disabled }));

    // AC-6: single available tool (claude, codex, antigravity) assigns all 8 roles with weak_independence, mitigations and no problems.
    const ac6Claude = proposeRoles(detectMod.DEFAULT_ROLES, tools(true, false, false), ['claude'], { code_dirs: ['src/'], test_dirs: ['tests/'] });
    const ac6Codex = proposeRoles(detectMod.DEFAULT_ROLES, tools(false, true, false), ['codex'], { code_dirs: ['src/'], test_dirs: ['tests/'] });
    const ac6Agy = proposeRoles(detectMod.DEFAULT_ROLES, tools(false, false, true), ['antigravity'], { code_dirs: ['src/'], test_dirs: ['tests/'] });
    const ac6SingleOk = [['claude', ac6Claude], ['codex', ac6Codex], ['antigravity', ac6Agy]].every(([toolName, p]) => (
      allRoles.every((r) => p.roles?.[r] === toolName)
      && p.weakIndependence === true
      && ['review', 'qa_design', 'qa_run'].every((r) => p.weakRoles?.includes(r))
      && Array.isArray(p.mitigations) && p.mitigations.length >= 4
      && Array.isArray(p.problems) && p.problems.length === 0
    ));
    const ac6CodexFallbacksOk = ['architect', 'review'].every((r) => ac6Codex.changes?.some((c) => c.role === r && c.from === 'antigravity' && c.to === 'codex'))
      && ['ba', 'teamlead', 'report'].every((r) => ac6Codex.changes?.some((c) => c.role === r && c.from === 'claude' && c.to === 'codex'));
    check('t2045-ac6: single tool (claude, codex, antigravity) assigns all 8 roles with weakIndependence and fallback to codex',
      ac6SingleOk && ac6CodexFallbacksOk,
      JSON.stringify({ ac6Claude, ac6Codex, ac6Agy }));

    // AC-7: dev on antigravity with all 3 tools available moves review, qa_design and qa_run to claude while architect stays on antigravity.
    const ac7Plan = proposeRoles({ ...detectMod.DEFAULT_ROLES, dev: 'antigravity' }, allFound, ['claude', 'codex', 'antigravity'], {
      code_dirs: ['src/'],
      test_dirs: ['tests/'],
    });
    check('t2045-ac7: dev on antigravity moves review, qa_design and qa_run to claude while architect stays on antigravity',
      ac7Plan.roles?.dev === 'antigravity'
      && ac7Plan.roles?.architect === 'antigravity'
      && ['review', 'qa_design', 'qa_run'].every((r) => ac7Plan.roles?.[r] === 'claude' && ac7Plan.changes?.some((c) => c.role === r && c.from === 'antigravity' && c.to === 'claude'))
      && ac7Plan.weakIndependence === false,
      JSON.stringify(ac7Plan));

    // AC-28: unset role in preferred map receives its target tool and records the change for each of the 8 roles.
    const ac28PerRole = allRoles.map((role) => {
      const partial = { ...targetRoles };
      delete partial[role];
      const p = proposeRoles(partial, allFound, ['claude', 'codex', 'antigravity'], { code_dirs: ['src/'], test_dirs: ['tests/'] });
      return { role, got: p.roles?.[role], expected: targetRoles[role], inChanges: p.changes?.some((c) => c.role === role && c.to === targetRoles[role]) };
    });
    check('t2045-ac28: each unset role receives its target tool from fallback queue and records transition in changes',
      ac28PerRole.every((x) => x.got === x.expected && x.inChanges),
      JSON.stringify(ac28PerRole));

    // AC-8: confirmed map with dev on codex and protected code_dirs keeps dev on codex with protected_paths patch warning and no problems.
    const ac8Sig = toolsMod.rolesSignature?.({ tools_enabled: ['claude', 'codex', 'antigravity'], roles: targetRoles });
    const ac8Plan = proposeRoles(targetRoles, allFound, ['claude', 'codex', 'antigravity'], {
      code_dirs: ['.agents/delivery/'],
      test_dirs: ['tests/'],
      confirmed: true,
      roles_confirmed: true,
      roles_signature: ac8Sig,
    });
    check('t2045-ac8: confirmed map keeps dev on codex in protected code_dirs with implementation.patch warning and no problems',
      ac8Plan.roles?.dev === 'codex'
      && !ac8Plan.changes?.some((c) => c.role === 'dev')
      && (ac8Plan.problems ?? []).length === 0
      && (ac8Plan.warnings ?? []).some((w) => /protected_paths/i.test(w) && /dev\b/.test(w) && /codex/i.test(w) && /implementation\.patch/.test(w) && /guard/i.test(w)),
      JSON.stringify(ac8Plan));

    // AC-29: confirmed map with qa_design on codex and protected test_dirs keeps qa_design on codex when dev != codex, and separates when dev == codex.
    const ac29QaRoles = { ...targetRoles, dev: 'claude', qa_design: 'codex' };
    const ac29QaSig = toolsMod.rolesSignature?.({ tools_enabled: ['claude', 'codex', 'antigravity'], roles: ac29QaRoles });
    const ac29KeepPlan = proposeRoles(ac29QaRoles, allFound, ['claude', 'codex', 'antigravity'], {
      code_dirs: ['src/'],
      test_dirs: ['.agents/delivery/lib/selftest.mjs'],
      confirmed: true,
      roles_confirmed: true,
      roles_signature: ac29QaSig,
    });
    const ac29BothCodexRoles = { ...targetRoles, dev: 'codex', qa_design: 'codex' };
    const ac29BothSig = toolsMod.rolesSignature?.({ tools_enabled: ['claude', 'codex', 'antigravity'], roles: ac29BothCodexRoles });
    const ac29SepPlan = proposeRoles(ac29BothCodexRoles, allFound, ['claude', 'codex', 'antigravity'], {
      code_dirs: ['.agents/delivery/'],
      test_dirs: ['.agents/delivery/lib/selftest.mjs'],
      confirmed: true,
      roles_confirmed: true,
      roles_signature: ac29BothSig,
    });
    check('t2045-ac29: confirmed map keeps qa_design on codex in protected test_dirs when dev != codex and separates when dev == codex',
      ac29KeepPlan.roles?.qa_design === 'codex'
      && !ac29KeepPlan.changes?.some((c) => c.role === 'qa_design')
      && (ac29KeepPlan.problems ?? []).length === 0
      && (ac29KeepPlan.warnings ?? []).some((w) => /protected_paths/i.test(w) && /qa_design\b/.test(w) && /codex/i.test(w) && /patch|патч/i.test(w))
      && ac29SepPlan.roles?.dev === 'codex'
      && ac29SepPlan.roles?.qa_design !== 'codex'
      && ac29SepPlan.changes?.some((c) => c.role === 'qa_design' && c.from === 'codex' && c.to === ac29SepPlan.roles.qa_design),
      JSON.stringify({ ac29KeepPlan, ac29SepPlan }));

    // AC-9: doctor --apply under AC-8 and AC-29 conditions preserves roles, roles_signature, roles_confirmed and permissions_confirmed.
    const docDir = fixture(base, 't2045-doctor', { 'package.json': JSON.stringify({ name: 'doc' }) });
    cli(docDir, 'install');
    const docCfgFile = resolve(docDir, '.agents/delivery/project.json');
    const docBaseCfg = JSON.parse(readFileSync(docCfgFile, 'utf8'));
    docBaseCfg.configured = true; docBaseCfg.language = 'uk'; docBaseCfg.base_branch = 'main';
    docBaseCfg.test.commands.file = 'node --test {path}';
    const fakeAllEnv = { DELIVERY_FAKE_TOOLS: JSON.stringify(allFound) };

    const ac9DevCfg = {
      ...docBaseCfg,
      tools_enabled: ['claude', 'codex', 'antigravity'],
      code_dirs: ['.agents/delivery/'],
      test_dirs: ['tests/'],
      roles: targetRoles,
      roles_confirmed: true,
      permissions_confirmed: true,
      roles_signature: ac8Sig,
    };
    writeFileSync(docCfgFile, JSON.stringify(ac9DevCfg, null, 2) + '\n');
    const ac9DevRes = cliEnv(docDir, fakeAllEnv, 'doctor', '--apply');
    const ac9DevAfter = JSON.parse(readFileSync(docCfgFile, 'utf8'));

    const ac9QaCfg = {
      ...docBaseCfg,
      tools_enabled: ['claude', 'codex', 'antigravity'],
      code_dirs: ['src/'],
      test_dirs: ['.agents/delivery/lib/selftest.mjs'],
      roles: ac29QaRoles,
      roles_confirmed: true,
      permissions_confirmed: false,
      roles_signature: ac29QaSig,
    };
    writeFileSync(docCfgFile, JSON.stringify(ac9QaCfg, null, 2) + '\n');
    const ac9QaRes = cliEnv(docDir, fakeAllEnv, 'doctor', '--apply');
    const ac9QaAfter = JSON.parse(readFileSync(docCfgFile, 'utf8'));
    check('t2045-ac9: doctor --apply preserves confirmed roles, roles_signature and permissions_confirmed under AC-8 and AC-29',
      ac9DevRes.code === 0
      && sameRoles(ac9DevAfter.roles, targetRoles)
      && ac9DevAfter.roles_signature === ac8Sig
      && ac9DevAfter.roles_confirmed === true
      && ac9DevAfter.permissions_confirmed === true
      && ac9QaRes.code === 0
      && sameRoles(ac9QaAfter.roles, ac29QaRoles)
      && ac9QaAfter.roles_signature === ac29QaSig
      && ac9QaAfter.roles_confirmed === true
      && ac9QaAfter.permissions_confirmed === false,
      JSON.stringify({ ac9DevAfter, ac9QaAfter }));

    // AC-10: unconfirmed map (roles_confirmed: false, mismatched signature, missing signature) switches dev and qa_design off codex.
    const unconfirmedStates = [
      { roles_confirmed: false, roles_signature: ac8Sig },
      { roles_confirmed: true, roles_signature: '0000000000000000000000000000000000000000' },
      { roles_confirmed: true },
    ];
    const ac10Results = [];
    for (const st of unconfirmedStates) {
      writeFileSync(docCfgFile, JSON.stringify({
        ...docBaseCfg,
        tools_enabled: ['claude', 'codex', 'antigravity'],
        code_dirs: ['.agents/delivery/'],
        test_dirs: ['tests/'],
        roles: targetRoles,
        ...st,
      }, null, 2) + '\n');
      const dRes = cliEnv(docDir, fakeAllEnv, 'doctor').json?.proposal;
      writeFileSync(docCfgFile, JSON.stringify({
        ...docBaseCfg,
        tools_enabled: ['claude', 'codex', 'antigravity'],
        code_dirs: ['src/'],
        test_dirs: ['.agents/delivery/lib/selftest.mjs'],
        roles: ac29QaRoles,
        ...st,
      }, null, 2) + '\n');
      const qRes = cliEnv(docDir, fakeAllEnv, 'doctor').json?.proposal;
      ac10Results.push({ dRes, qRes });
    }
    check('t2045-ac10: unconfirmed map in all 3 states moves dev and qa_design off codex in protected dirs and records changes',
      ac8Plan.roles?.dev === 'codex'
      && ac29KeepPlan.roles?.qa_design === 'codex'
      && ac10Results.every(({ dRes, qRes }) => (
        dRes?.roles?.dev === 'claude'
        && ['review', 'qa_design', 'qa_run'].every((r) => dRes?.roles?.[r] === 'antigravity')
        && dRes?.changes?.some((c) => c.role === 'dev' && c.from === 'codex' && c.to === 'claude')
        && (dRes?.warnings ?? []).some((w) => /protected_paths/i.test(w) && /claude/i.test(w))
        && qRes?.roles?.qa_design === 'antigravity'
        && qRes?.roles?.qa_design !== qRes?.roles?.dev
        && qRes?.changes?.some((c) => c.role === 'qa_design' && c.from === 'codex' && c.to === 'antigravity')
        && (qRes?.warnings ?? []).some((w) => /protected_paths/i.test(w) && /antigravity/i.test(w))
      )),
      JSON.stringify(ac10Results));

    // AC-11: confirmed map still moves dev or qa_design off codex when codex is missing or unauthorized.
    const noCodexTools = tools(true, false, true);
    const unauthCodexTools = { claude: { found: true }, codex: { found: true, flagsOk: true, authorized: false }, antigravity: { found: true } };
    const ac11Cases = [noCodexTools, unauthCodexTools].map((tSet) => ({
      devPlan: proposeRoles(detectMod.DEFAULT_ROLES, tSet, undefined, {
        code_dirs: ['.agents/delivery/'],
        test_dirs: ['tests/'],
        confirmed: true,
        roles_confirmed: true,
        roles_signature: ac8Sig,
      }),
      qaPlan: proposeRoles({ ...detectMod.DEFAULT_ROLES, dev: 'claude', qa_design: 'codex' }, tSet, undefined, {
        code_dirs: ['src/'],
        test_dirs: ['.agents/delivery/lib/selftest.mjs'],
        confirmed: true,
        roles_confirmed: true,
        roles_signature: ac29QaSig,
      }),
    }));
    check('t2045-ac11: confirmed map moves dev and qa_design off codex when codex is missing or unauthorized',
      sameRoles(detectMod.DEFAULT_ROLES, targetRoles)
      && ac11Cases.every(({ devPlan, qaPlan }) => (
        devPlan.roles?.dev === 'claude'
        && devPlan.roles?.architect === 'antigravity'
        && devPlan.roles?.review === 'antigravity'
        && devPlan.changes?.some((c) => c.role === 'dev' && c.from === 'codex' && c.to === 'claude')
        && qaPlan.roles?.qa_design === 'antigravity'
        && qaPlan.changes?.some((c) => c.role === 'qa_design' && c.from === 'codex' && c.to === 'antigravity')
      )),
      JSON.stringify(ac11Cases));

    // AC-30: qa-design.md and deliver.md specify test patch protocol when test_dirs is not writable.
    const qaDesignRoleText = readFileSync(resolve(moduleDir, 'roles/qa-design.md'), 'utf8');
    check('t2045-ac30: qa-design.md and deliver.md specify test patch protocol when test_dirs is not writable',
      /\.agents|\.git|codex/i.test(qaDesignRoleText)
      && /patch/i.test(qaDesignRoleText)
      && /07-test-cases\.md/.test(qaDesignRoleText)
      && /guard\s+<task>\s+--tests-only/.test(deliverRoleText)
      && /lock-tests/.test(deliverRoleText)
      && /qa[-_]design[\s\S]{0,600}patch|patch[\s\S]{0,600}guard\s+<task>\s+--tests-only/i.test(deliverRoleText),
      'missing test patch protocol in roles/qa-design.md or roles/deliver.md');

    // AC-12: non-blocking recommendations per role in doctor without changing roles, changes, warnings, problems or ok.
    const ac12Roles = {
      ba: 'antigravity',
      report: 'antigravity',
      teamlead: 'claude',
      architect: 'claude',
      dev: 'claude',
      qa_design: 'codex',
      review: 'codex',
      qa_run: 'codex',
    };
    const ac12Sig = toolsMod.rolesSignature?.({ tools_enabled: ['claude', 'codex', 'antigravity'], roles: ac12Roles });
    writeFileSync(docCfgFile, JSON.stringify({
      ...docBaseCfg,
      tools_enabled: ['claude', 'codex', 'antigravity'],
      code_dirs: ['src/'],
      test_dirs: ['tests/'],
      roles: ac12Roles,
      roles_confirmed: true,
      roles_signature: ac12Sig,
    }, null, 2) + '\n');
    const ac12Doc = cliEnv(docDir, fakeAllEnv, 'doctor');
    const ac12Recs = getRecs(ac12Doc.json);
    check('t2045-ac12: doctor returns non-blocking recommendations for ba, report, architect, qa_design, review, qa_run and omits dev',
      ac12Doc.code === 0 && ac12Doc.json?.ok === true
      && sameRoles(ac12Doc.json?.proposal?.roles, ac12Roles)
      && (ac12Doc.json?.proposal?.changes ?? []).length === 0
      && (ac12Doc.json?.proposal?.warnings ?? []).length === 0
      && (ac12Doc.json?.problems ?? []).length === 0
      && Array.isArray(ac12Recs) && ac12Recs.length === 6
      && hasRec(ac12Recs, 'ba', 'antigravity', 'claude')
      && hasRec(ac12Recs, 'report', 'antigravity', 'claude')
      && hasRec(ac12Recs, 'architect', 'claude', 'antigravity')
      && hasRec(ac12Recs, 'qa_design', 'codex', 'antigravity')
      && hasRec(ac12Recs, 'review', 'codex', 'antigravity')
      && hasRec(ac12Recs, 'qa_run', 'codex', 'antigravity')
      && !hasAnyRecForRole(ac12Recs, 'dev')
      && !hasAnyRecForRole(ac12Recs, 'teamlead'),
      JSON.stringify(ac12Doc.json));

    // AC-13: doctor --apply does not apply recommendations and preserves previous roles in project.json.
    const ac13Apply = cliEnv(docDir, fakeAllEnv, 'doctor', '--apply');
    const ac13After = JSON.parse(readFileSync(docCfgFile, 'utf8'));
    const ac13Recs = getRecs(ac13Apply.json);
    check('t2045-ac13: doctor --apply does not apply recommendations and keeps roles in project.json unchanged',
      ac13Apply.code === 0
      && Array.isArray(ac13Recs) && ac13Recs.length === 6
      && sameRoles(ac13After.roles, ac12Roles),
      JSON.stringify({ ac13Apply: ac13Apply.json, ac13After }));

    // AC-14: negative cases where no recommendation is emitted.
    const ac14TargetDisabled = proposeRoles({ ...targetRoles, architect: 'claude', review: 'claude', qa_design: 'claude', qa_run: 'claude' }, allFound, ['claude', 'codex'], { code_dirs: ['src/'], test_dirs: ['tests/'] });
    const ac14DevAgy = proposeRoles({ ...targetRoles, dev: 'antigravity', review: 'claude', qa_design: 'claude', qa_run: 'claude' }, allFound, ['claude', 'codex', 'antigravity'], { code_dirs: ['src/'], test_dirs: ['tests/'] });
    const ac14DevProt = proposeRoles({ ...targetRoles, dev: 'claude' }, allFound, ['claude', 'codex', 'antigravity'], { code_dirs: ['.agents/delivery/'], test_dirs: ['tests/'] });
    const ac14ToolDown = proposeRoles({ ...targetRoles, architect: 'codex', dev: 'claude' }, tools(true, false, true), undefined, { code_dirs: ['src/'], test_dirs: ['tests/'] });
    check('t2045-ac14: doctor omits recommendations in all negative cases (disabled target, already on target, dev conflict, protected dirs, unavailable source tool)',
      Array.isArray(getRecs(ac14TargetDisabled)) && getRecs(ac14TargetDisabled).length === 0
      && Array.isArray(getRecs(ac14DevAgy))
      && !hasAnyRecForRole(getRecs(ac14DevAgy), 'review')
      && !hasAnyRecForRole(getRecs(ac14DevAgy), 'qa_design')
      && !hasAnyRecForRole(getRecs(ac14DevAgy), 'qa_run')
      && hasRec(getRecs(ac14DevAgy), 'dev', 'antigravity', 'codex')
      && Array.isArray(getRecs(ac14DevProt)) && !hasAnyRecForRole(getRecs(ac14DevProt), 'dev')
      && Array.isArray(getRecs(ac14ToolDown))
      && ac14ToolDown.changes?.some((c) => c.role === 'architect' && c.from === 'codex' && c.to === 'antigravity')
      && !hasAnyRecForRole(getRecs(ac14ToolDown), 'architect'),
      JSON.stringify({ ac14TargetDisabled, ac14DevAgy, ac14DevProt, ac14ToolDown }));

    // AC-15: deliver.md requires showing recommendations to PO on every start in one line without asking or stopping, regardless of roles_confirmed.
    check('t2045-ac15: deliver.md requires showing doctor recommendations on every start as one line without prompting or stopping',
      /recommend/i.test(deliverRoleText)
      && /one line|single line|одним рядком/i.test(deliverRoleText),
      'missing recommendation display instruction in roles/deliver.md');

    // AC-16: existing project with confirmed legacy map (architect and review on claude) keeps roles and confirmation across upgrade/migrate-config + config.
    const ac16Dir = fixture(base, 't2045-ac16', { 'package.json': JSON.stringify({ name: 'ac16' }) });
    cli(ac16Dir, 'install');
    const ac16CfgFile = resolve(ac16Dir, '.agents/delivery/project.json');
    const ac16Base = JSON.parse(readFileSync(ac16CfgFile, 'utf8'));
    const legacySig = toolsMod.rolesSignature?.({ roles: pref });
    const ac16Initial = {
      ...ac16Base,
      module_version: '0.1.0',
      configured: true,
      language: 'uk',
      base_branch: 'main',
      test: { ...ac16Base.test, commands: { ...ac16Base.test.commands, file: 'node --test {path}' } },
      roles: pref,
      roles_confirmed: true,
      permissions_confirmed: true,
      roles_signature: legacySig,
    };
    writeFileSync(ac16CfgFile, JSON.stringify(ac16Initial, null, 2) + '\n');
    const ac16Mig = cli(ac16Dir, 'migrate-config');
    const ac16Upg = cli(ac16Dir, 'upgrade', dir);
    const ac16CfgRes = cli(ac16Dir, 'config');
    const ac16After = JSON.parse(readFileSync(ac16CfgFile, 'utf8'));
    check('t2045-ac16: upgrade and migrate-config preserve confirmed legacy map and config returns ok true with roles_reset false',
      sameRoles(detectMod.DEFAULT_ROLES, targetRoles)
      && ac16Mig.code === 0 && ac16Upg.code === 0
      && ac16CfgRes.code === 0 && ac16CfgRes.json?.ok === true && ac16CfgRes.json?.roles_reset === false
      && sameRoles(ac16After.roles, pref)
      && ac16After.roles_confirmed === true,
      JSON.stringify({ ac16CfgRes: ac16CfgRes.json, ac16After }));

    // AC-17: non-conductor role texts do not require forbidden delivery.mjs subcommands, writing to .agents/.git, committing, or Claude-only features.
    const workerRoles = ['ba', 'triage', 'plan', 'architect', 'qa-design', 'dev', 'review', 'qa-run', 'report', 'bootstrap'];
    const ac17Violations = [];
    for (const rName of workerRoles) {
      const text = readFileSync(resolve(moduleDir, `roles/${rName}.md`), 'utf8');
      if (/\bsubagent\b|\bAgent tool\b/i.test(text)) ac17Violations.push(`${rName}: mentions Claude-only subagent/Agent tool`);
      if (/^\s*\d+\.\s*Commit\b/im.test(text)) ac17Violations.push(`${rName}: requires role to commit`);
      if (/Run `config`|delivery\.mjs\s+(?:config|doctor|perms|lock-tests|install|init-config|upgrade|migrate-config|export)\b/i.test(text)) {
        ac17Violations.push(`${rName}: requires running forbidden delivery.mjs subcommand`);
      }
      if (/Update\s+`?\.agents\/delivery\/project\.json`?/i.test(text)) {
        ac17Violations.push(`${rName}: requires writing .agents/delivery/project.json`);
      }
    }
    check('t2045-ac17: worker role files do not require committing, writing to .agents/.git, mutating subcommands or Claude-only tools',
      ac17Violations.length === 0,
      ac17Violations.join('; '));

    // AC-27: deliver.md requires conductor to commit after dev, qa_design and bootstrap for any tool with AC ids from 08-dev-log.md, and dev.md requires AC ids in 08-dev-log.md.
    check('t2045-ac27: deliver.md requires conductor commit after dev, qa_design and bootstrap for any tool and dev.md requires AC ids in 08-dev-log.md',
      /08-dev-log\.md[\s\S]{0,250}AC\s+ids|AC\s+ids[\s\S]{0,250}08-dev-log\.md/i.test(devRoleText)
      && !/^\s*\d+\.\s*Commit\b/im.test(devRoleText)
      && /08-dev-log\.md[\s\S]{0,250}AC\s+ids|AC\s+ids[\s\S]{0,250}08-dev-log\.md/i.test(deliverRoleText)
      && /claude,\s*codex\s+(?:or|and|чи)\s+antigravity|regardless of (?:its )?tool|незалежно від (?:її )?інструмента/i.test(deliverRoleText),
      'missing conductor commit or AC ids in 08-dev-log.md requirement in deliver.md / dev.md');

    // AC-18: report reads weak independence data from task directory artifact prepared by conductor without running config.
    const reportTemplateText = readFileSync(resolve(moduleDir, 'templates/report.md'), 'utf8');
    check('t2045-ac18: report role reads weak independence data from task directory artifact prepared by conductor without running config',
      !/Run `config`/i.test(reportRoleText)
      && /task directory|катало[гз]і задачі|<task>/i.test(reportRoleText)
      && /weak[ _-]independence/i.test(deliverRoleText)
      && /report[\s\S]{0,400}weak|weak[\s\S]{0,400}report/i.test(deliverRoleText)
      && /weak independence/i.test(reportTemplateText),
      'report.md or deliver.md missing task artifact handoff for weak independence');

    // AC-19: bootstrap passes new project.json values via task directory and conductor updates project.json and runs config.
    const bootstrapRoleText = readFileSync(resolve(moduleDir, 'roles/bootstrap.md'), 'utf8');
    check('t2045-ac19: bootstrap role passes project.json settings via task directory and conductor writes project.json and runs config',
      !/Update\s+`?\.agents\/delivery\/project\.json`?/i.test(bootstrapRoleText)
      && !/delivery\.mjs\s+config/i.test(bootstrapRoleText)
      && /task directory|катало[гз]|08-dev-log\.md|\.json/i.test(bootstrapRoleText)
      && !/The bootstrap role updates `project\.json` itself/i.test(deliverRoleText)
      && /project\.json[\s\S]{0,200}config/i.test(deliverRoleText),
      'bootstrap.md or deliver.md still requires bootstrap role to edit project.json directly');

    // AC-20 & AC-31: antigravity permissions use absolute paths inside root, block all mutating subcommands without lookahead, keep dangerous command denials, and scope write_file.
    const ac20Perms = toolsMod.proposePermissions({
      ...cfg,
      code_dirs: ['src/'],
      test_dirs: ['tests', '.agents/delivery/lib/selftest.mjs'],
      forbidden_paths: ['**/.env', '**/.env.*', '**/*.pem', '**/*.key'],
      roles: targetRoles,
    }, targetRoles);
    const agyP = ac20Perms.antigravity ?? {};
    const allMutatingSubs = ['lock-tests', 'install', 'config', 'doctor', 'perms', 'init-config', 'upgrade', 'migrate-config', 'export'];
    const dangerousCmds = ['sudo apt', 'rm -rf /tmp/x', 'git push origin main', 'git reset --hard', 'git checkout -- .', 'git clean -fd', 'php artisan migrate'];
    const safeGitCmds = ['git diff', 'git log -n 5', 'git show HEAD'];
    const fileRules = [...(agyP.allow ?? []), ...(agyP.deny ?? [])].filter((r) => /^(?:read|write)_file\(/.test(r));
    const isAbsFileRule = (rule) => {
      const inner = rule.replace(/^(?:read|write)_file\(/, '').slice(0, -1);
      if (inner === '*') return true;
      return inner.startsWith(`${rootPosix}/`) && !inner.includes('\\');
    };
    const noLookahead = (agyP.deny ?? []).every((r) => !/\(\?[!=]/.test(r));
    check('t2045-ac20-ac31: antigravity rules use absolute paths in root, block all mutating subcommands and dangerous commands without lookahead, and allow safe ones',
      fileRules.length >= 5
      && fileRules.every(isAbsFileRule)
      && agyP.allow?.includes('read_file(*)')
      && agyP.allow?.includes(`write_file(${rootPosix}/tests/)`)
      && agyP.allow?.includes(`write_file(${rootPosix}/.agents/delivery/lib/selftest.mjs)`)
      && agyP.allow?.includes(`write_file(${rootPosix}/.work/)`)
      && !agyP.allow?.some((r) => r.includes('/src/'))
      && agyP.deny?.includes(`write_file(${rootPosix}/.git/)`)
      && agyP.deny?.includes(`read_file(${rootPosix}/.env)`)
      && agyP.deny?.includes(`write_file(${rootPosix}/.env)`)
      && noLookahead
      && allMutatingSubs.every((sub) => agyMatchesRule(agyP.deny, `node .agents/delivery/delivery.mjs ${sub}`))
      && dangerousCmds.every((cmd) => agyMatchesRule(agyP.deny, cmd))
      && safeSubs.every((sub) => !agyMatchesRule(agyP.deny, `node .agents/delivery/delivery.mjs ${sub}`))
      && safeGitCmds.every((cmd) => !agyMatchesRule(agyP.deny, cmd)),
      JSON.stringify(agyP));

    // AC-32: perms and perms --apply on fixture global agy file without relative rules enable sandbox settings, preserve existing keys/rules and create backup; checkToolOutput catches sandbox non-absolute path error.
    const ac32Home = resolve(base, 'agy-clean');
    const ac32AgyFile = resolve(ac32Home, '.gemini/antigravity-cli/settings.json');
    mkdirSync(dirname(ac32AgyFile), { recursive: true });
    const ac32Initial = {
      theme: 'dark',
      toolPermission: 'ask',
      enableTerminalSandbox: false,
      permissions: {
        allow: ['read_file(*)', 'write_file(D:/other/project/.work/)'],
        deny: ['write_file(D:/other/project/.git/)'],
      },
    };
    writeFileSync(ac32AgyFile, JSON.stringify(ac32Initial, null, 2) + '\n');
    const ac32Env = { HOME: ac32Home, USERPROFILE: ac32Home, DELIVERY_AGY_SETTINGS: ac32AgyFile };
    writeFileSync(docCfgFile, JSON.stringify({
      ...docBaseCfg,
      roles: targetRoles,
      permissions_confirmed: false,
    }, null, 2) + '\n');
    const ac32PlanRes = cliEnv(docDir, ac32Env, 'perms');
    const ac32BeforeApplyRaw = readFileSync(ac32AgyFile, 'utf8');
    const ac32ApplyRes = cliEnv(docDir, ac32Env, 'perms', '--apply');
    const ac32AfterApply = JSON.parse(readFileSync(ac32AgyFile, 'utf8'));
    const ac32CfgAfter = JSON.parse(readFileSync(docCfgFile, 'utf8'));
    const ac32Backups = readdirSync(dirname(ac32AgyFile)).filter((f) => f.startsWith('settings.json.bak-delivery-'));
    const outSandboxErr = checkToolOutput('Command failed to run: sandbox configuration error: readonly .git/: non-absolute file path.');
    check('t2045-ac32: perms and perms --apply with clean agy file configure proceed-in-sandbox, preserve keys/rules, create backup and set permissions_confirmed',
      ac32PlanRes.code === 0
      && /proceed-in-sandbox/.test(ac32PlanRes.raw)
      && /enableTerminalSandbox/.test(ac32PlanRes.raw)
      && /"ask"|ask/.test(ac32PlanRes.raw)
      && ac32BeforeApplyRaw === JSON.stringify(ac32Initial, null, 2) + '\n'
      && ac32ApplyRes.code === 0
      && ac32Backups.length >= 1
      && ac32AfterApply.theme === 'dark'
      && ac32AfterApply.toolPermission === 'proceed-in-sandbox'
      && ac32AfterApply.enableTerminalSandbox === true
      && ac32AfterApply.permissions?.allow?.includes('write_file(D:/other/project/.work/)')
      && ac32AfterApply.permissions?.deny?.includes('write_file(D:/other/project/.git/)')
      && !(ac32AfterApply.permissions?.allow ?? []).some((r) => r.startsWith('command('))
      && ac32CfgAfter.permissions_confirmed === true
      && !outSandboxErr.ok,
      JSON.stringify({ plan: ac32PlanRes.json, apply: ac32ApplyRes.json, after: ac32AfterApply, cfgAfter: ac32CfgAfter, outSandboxErr }));

    // AC-33: perms and perms --apply when global agy file contains relative file rules (own old and other projects').
    const ac33Home = resolve(base, 'agy-rel');
    const ac33AgyFile = resolve(ac33Home, '.gemini/antigravity-cli/settings.json');
    mkdirSync(dirname(ac33AgyFile), { recursive: true });
    const relAllowRules = ['write_file(.work/)', 'write_file(internal/)', 'read_file(docker/php/certs/)'];
    const relDenyRules = ['write_file(.git/)', 'write_file(src/services/)'];
    const ac33Initial = {
      theme: 'light',
      toolPermission: 'ask',
      enableTerminalSandbox: false,
      permissions: {
        allow: ['read_file(*)', 'write_file(D:/other/project/.work/)', ...relAllowRules],
        deny: ['write_file(D:/other/project/.git/)', ...relDenyRules],
      },
    };
    writeFileSync(ac33AgyFile, JSON.stringify(ac33Initial, null, 2) + '\n');
    const ac33Env = { HOME: ac33Home, USERPROFILE: ac33Home, DELIVERY_AGY_SETTINGS: ac33AgyFile };
    writeFileSync(docCfgFile, JSON.stringify({
      ...docBaseCfg,
      roles: targetRoles,
      permissions_confirmed: false,
    }, null, 2) + '\n');
    const ac33PlanRes = cliEnv(docDir, ac33Env, 'perms');
    const ac33ApplyRes = cliEnv(docDir, ac33Env, 'perms', '--apply');
    const ac33AfterFirst = JSON.parse(readFileSync(ac33AgyFile, 'utf8'));
    const ac33CfgAfterFirst = JSON.parse(readFileSync(docCfgFile, 'utf8'));
    const docDirPosix = toPosix(docDir);
    const allRelListed = [...relAllowRules, ...relDenyRules].every((r) => ac33PlanRes.raw.includes(r));
    const existingPreserved = [...relAllowRules, 'read_file(*)', 'write_file(D:/other/project/.work/)'].every((r) => ac33AfterFirst.permissions?.allow?.includes(r))
      && [...relDenyRules, 'write_file(D:/other/project/.git/)'].every((r) => ac33AfterFirst.permissions?.deny?.includes(r));

    // Now remove relative rules manually and run perms --apply again.
    const ac33Cleaned = {
      ...ac33AfterFirst,
      permissions: {
        allow: ac33AfterFirst.permissions.allow.filter((r) => !relAllowRules.includes(r)),
        deny: ac33AfterFirst.permissions.deny.filter((r) => !relDenyRules.includes(r)),
      },
    };
    writeFileSync(ac33AgyFile, JSON.stringify(ac33Cleaned, null, 2) + '\n');
    const ac33SecondApply = cliEnv(docDir, ac33Env, 'perms', '--apply');
    const ac33AfterSecond = JSON.parse(readFileSync(ac33AgyFile, 'utf8'));
    const ac33CfgAfterSecond = JSON.parse(readFileSync(docCfgFile, 'utf8'));
    check('t2045-ac33: relative file rules in agy settings are reported, block sandbox activation and permissions_confirmed until manually fixed',
      ac33PlanRes.code === 0
      && allRelListed
      && /sandbox/i.test(ac33PlanRes.raw)
      && /абсолют|absolute|вручну|manual/i.test(ac33PlanRes.raw)
      && ac33ApplyRes.code === 0
      && existingPreserved
      && ac33AfterFirst.toolPermission === 'ask'
      && ac33AfterFirst.enableTerminalSandbox === false
      && ac33AfterFirst.permissions?.allow?.includes(`write_file(${docDirPosix}/.work/)`)
      && ac33AfterFirst.permissions?.deny?.includes(`write_file(${docDirPosix}/.git/)`)
      && /sandbox|toolPermission|відносн|relative/i.test(ac33ApplyRes.raw)
      && ac33CfgAfterFirst.permissions_confirmed === false
      && ac33SecondApply.code === 0
      && ac33AfterSecond.toolPermission === 'proceed-in-sandbox'
      && ac33AfterSecond.enableTerminalSandbox === true
      && ac33CfgAfterSecond.permissions_confirmed === true,
      JSON.stringify({ plan: ac33PlanRes.json, apply1: ac33ApplyRes.json, after1: ac33AfterFirst, cfg1: ac33CfgAfterFirst, after2: ac33AfterSecond, cfg2: ac33CfgAfterSecond }));

    // AC-34: deliver.md requires asking PO once when perms proposes missing rules/settings even if permissions_confirmed is true, and reporting relative rules without stopping.
    check('t2045-ac34: deliver.md requires prompting when perms has unapplied rules/settings regardless of permissions_confirmed and reporting relative rules without stopping',
      !/If `addAllow`\/`addDeny` is non-empty and `permissions_confirmed` is not true/i.test(deliverRoleText)
      && /relative|відносн/i.test(deliverRoleText)
      && /perms --apply/.test(deliverRoleText),
      'roles/deliver.md permissions step not updated for AC-34');

    // AC-35: perms warns when antigravity is used with test.env === 'docker' and adds no unsandboxed(...) rules.
    writeFileSync(docCfgFile, JSON.stringify({
      ...docBaseCfg,
      roles: targetRoles,
      test: { ...docBaseCfg.test, env: 'docker', service: 'app', exec_prefix: 'docker compose exec -T app' },
    }, null, 2) + '\n');
    const ac35Perms = cliEnv(docDir, ac32Env, 'perms');
    check('t2045-ac35: perms with antigravity and test.env docker warns about Docker/network in sandbox and adds no unsandboxed rules',
      ac35Perms.code === 0
      && /docker/i.test(ac35Perms.raw)
      && /blocked/i.test(ac35Perms.raw)
      && !/unsandboxed\(/i.test(ac35Perms.raw),
      ac35Perms.raw);

    // AC-25: INSTALL.md explicitly states target default role map, perms/perms --apply with sandbox and absolute paths, and Claude Code / Codex conductor.
    const installText = readFileSync(resolve(moduleDir, 'INSTALL.md'), 'utf8');
    check('t2045-ac25: INSTALL.md lists target default role map and perms --apply with agy sandbox and absolute paths',
      /architect[\s\S]{0,120}antigravity|antigravity[\s\S]{0,120}architect/i.test(installText)
      && /review[\s\S]{0,120}antigravity|antigravity[\s\S]{0,120}review/i.test(installText)
      && /perms --apply/.test(installText)
      && /sandbox/i.test(installText)
      && /absolute|абсолют/i.test(installText),
      'INSTALL.md missing target default role map or perms --apply sandbox instructions');

    // AC-24 & AC-26 & Round 4 supplement: README.md covers all required topics, conductor restriction, and exact selftest count.
    const expectedTotalChecks = results.length + 1;
    const readmeCountMatch = readmeText.match(/selftest[^\n]*?\((\d+)\s+перевір/i);
    check('t2045-ac24-ac26: README.md documents target role map, confirmed map priority, recommendations, agy sandbox/absolute paths, conductor restriction and exact selftest count',
      /architect[\s\S]{0,200}antigravity/i.test(readmeText)
      && /review[\s\S]{0,200}antigravity/i.test(readmeText)
      && /proceed-in-sandbox/.test(readmeText)
      && /enableTerminalSandbox/.test(readmeText)
      && !/Прапорець `--sandbox` проблему не вирішує/.test(readmeText)
      && !/Gemini\/Antigravity або Claude Code/.test(readmeText)
      && !/Gemini\/Antigravity або Codex/.test(readmeText)
      && Number(readmeCountMatch?.[1]) === expectedTotalChecks,
      `README checks failed or count mismatch: found ${readmeCountMatch?.[1]}, expected ${expectedTotalChecks}`);
  } finally {
    if (prevAgyEnv === undefined) delete process.env.DELIVERY_AGY_SETTINGS;
    else process.env.DELIVERY_AGY_SETTINGS = prevAgyEnv;
    activeEnv = {};
    rmSync(base, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  return { ok: failed.length === 0, total: results.length, failed, results: results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ' :: ' + r.detail : ''}`) };
}
