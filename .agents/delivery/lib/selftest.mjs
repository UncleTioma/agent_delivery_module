// Self-test: builds throwaway fixture projects, copies this module into each (as a user would),
// and checks detection, installation, config, permissions planning, guards and failure detection.
// Spends no tokens and calls no AI tool.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { moduleDir } from './util.mjs';
import * as toolsMod from './tools.mjs';
const { proposeRoles, checkToolOutput } = toolsMod;

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) });

function sh(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8' });
}

function cli(dir, ...args) {
  const r = sh('node', [resolve(dir, '.agents/delivery/delivery.mjs'), ...args], dir);
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

    const codexAgyRoles = { ba: 'antigravity', teamlead: 'antigravity', architect: 'antigravity', qa_design: 'antigravity', dev: 'codex', review: 'antigravity', qa_run: 'antigravity', report: 'antigravity' };
    const permsCodexAgy = toolsMod.proposePermissions({ ...cfg, code_dirs: ['src/'], test_dirs: ['tests/'], roles: codexAgyRoles }, codexAgyRoles);
    check('ac21: permissions for codex+gemini omit claude and do not grant code_dirs write when agy is not dev',
      !('claude' in permsCodexAgy)
      && 'antigravity' in permsCodexAgy
      && permsCodexAgy.antigravity.allow.includes('write_file(tests/)')
      && !permsCodexAgy.antigravity.allow.includes('write_file(src/)'),
      JSON.stringify(permsCodexAgy));

    const onlyAgyRoles = Object.fromEntries(allRoles.map((r) => [r, 'antigravity']));
    const permsOnlyAgy = toolsMod.proposePermissions({ ...cfg, code_dirs: ['src/'], test_dirs: ['tests/'], roles: onlyAgyRoles }, onlyAgyRoles);
    check('ac21: permissions for gemini-only grant write_file on code_dirs because agy is dev',
      !('claude' in permsOnlyAgy)
      && 'antigravity' in permsOnlyAgy
      && permsOnlyAgy.antigravity.allow.includes('write_file(src/)')
      && permsOnlyAgy.antigravity.allow.includes('write_file(tests/)'),
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
    const agyAllowsCmd = (p, cmdLine) => agyMatchesRule(p?.allow, cmdLine) && !agyMatchesRule(p?.deny, cmdLine);
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
      permsFileTestDir.antigravity?.allow?.includes('write_file(.agents/delivery/lib/selftest.mjs)')
      && !permsFileTestDir.antigravity?.allow?.includes('write_file(.agents/delivery/lib/selftest.mjs/)')
      && permsFileTestDir.antigravity?.allow?.includes('write_file(tests/)'),
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
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  return { ok: failed.length === 0, total: results.length, failed, results: results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ' :: ' + r.detail : ''}`) };
}
