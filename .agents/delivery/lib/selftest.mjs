// Self-test: builds throwaway fixture projects, copies this module into each (as a user would),
// and checks detection, installation, config, permissions planning, guards and failure detection.
// Spends no tokens and calls no AI tool.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { moduleDir } from './util.mjs';
import { proposeRoles, checkToolOutput } from './tools.mjs';

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
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  return { ok: failed.length === 0, total: results.length, failed, results: results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ' :: ' + r.detail : ''}`) };
}
