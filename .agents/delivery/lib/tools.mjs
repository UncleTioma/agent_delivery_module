// Environment checks (doctor), role remapping and permission proposals (perms).
import { existsSync, statSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { root, readJson, run, toPosix } from './util.mjs';
import { DEFAULT_ROLES } from './detect.mjs';

const WIN = process.platform === 'win32';
const TOOLS = ['claude', 'codex', 'antigravity'];
const ROLES = ['ba', 'teamlead', 'architect', 'qa_design', 'dev', 'review', 'qa_run', 'report'];

function canonicalTool(tool) {
  return tool === 'gemini' ? 'antigravity' : tool;
}

/** Canonical tool names in stable order, with invalid names kept for diagnostics. */
export function normalizeTools(list) {
  const names = new Set(list.map(canonicalTool));
  return { tools: TOOLS.filter((t) => names.has(t)), unknown: [...names].filter((t) => !TOOLS.includes(t)) };
}
const BINARY = { claude: 'claude', codex: 'codex', antigravity: 'agy' };

/** Fresh PATH from the registry on Windows: a shell started before an install does not see new tools. */
function freshPath() {
  if (!WIN) return process.env.PATH;
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    "[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')"],
  { encoding: 'utf8' });
  return r.status === 0 ? `${r.stdout.trim()};${process.env.PATH}` : process.env.PATH;
}

function tryVersion(bin, env) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', env, shell: WIN, timeout: 20000 });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || r.stderr).trim().split(/\r?\n/)[0] || 'unknown';
}

function helpText(bin, args, env) {
  const r = spawnSync(bin, args, { encoding: 'utf8', env, shell: WIN, timeout: 20000 });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

export function inspectTools({ probe = false } = {}) {
  // Selftest hook; unset during normal tool discovery.
  if (process.env.DELIVERY_FAKE_TOOLS !== undefined) {
    try { return JSON.parse(process.env.DELIVERY_FAKE_TOOLS); }
    catch { throw new Error('DELIVERY_FAKE_TOOLS must contain valid JSON'); }
  }
  let env = process.env;
  const result = {};
  for (const tool of TOOLS) {
    const bin = BINARY[tool];
    let version = tryVersion(bin, env);
    let pathRefreshed = false;
    if (!version && WIN) {
      env = { ...process.env, PATH: freshPath() };
      version = tryVersion(bin, env);
      pathRefreshed = !!version;
    }
    const insideClaude = tool === 'claude' && (process.env.CLAUDECODE === '1' || !!process.env.CLAUDE_CODE_SESSION_ID);
    const info = { found: !!version || insideClaude, version, pathRefreshed, flagsOk: null, authorized: null, note: null };
    if (insideClaude && !version) info.note = 'running inside Claude Code: subagents do not need the claude CLI on PATH';
    if (version && tool === 'codex') {
      info.flagsOk = /--sandbox/.test(helpText(bin, ['exec', '--help'], env));
      if (probe) info.authorized = spawnSync(bin, ['login', 'status'], { env, shell: WIN, timeout: 20000 }).status === 0;
    }
    if (version && tool === 'antigravity') {
      const h = helpText(bin, ['--help'], env);
      info.flagsOk = /--print/.test(h) && /--output-format/.test(h);
      if (probe) {
        const m = spawnSync(bin, ['models'], { encoding: 'utf8', env, shell: WIN, timeout: 30000 });
        info.authorized = m.status === 0 && !/login|sign in|unauthor/i.test(`${m.stdout}${m.stderr}`);
      }
    }
    if (version && tool === 'claude') info.flagsOk = true;
    if (pathRefreshed) info.note = 'found only after refreshing PATH: restart the terminal';
    result[tool] = info;
  }
  return result;
}

export function inspectBasics(cfg) {
  const git = run('git', ['--version']);
  const docker = cfg?.test?.env === 'docker'
    ? run('docker', ['compose', 'ps', '-q'], { shell: WIN })
    : null;
  return {
    node: process.version,
    git: git.code === 0 ? git.stdout.trim() : null,
    docker: docker ? { needed: true, ok: docker.code === 0 } : { needed: false, ok: null },
    platform: process.platform,
  };
}

const FALLBACK = {
  dev: ['codex', 'claude', 'antigravity'],
  architect: ['antigravity', 'claude', 'codex'],
  qa_design: ['antigravity', 'claude', 'codex'],
  qa_run: ['antigravity', 'claude', 'codex'],
  review: ['antigravity', 'claude', 'codex'],
  default: ['claude', 'antigravity', 'codex'],
};

/** Propose all roles using the enabled, usable tools, separating review and QA from dev. */
export function proposeRoles(preferred, tools, toolsEnabled, dirs = {}) {
  const confirmed = dirs.confirmed !== undefined ? dirs.confirmed === true
    : dirs.roles_confirmed === true && !!dirs.roles_signature
      && dirs.roles_signature === rolesSignature({ tools_enabled: toolsEnabled, roles: preferred });
  const enabled = normalizeTools(Array.isArray(toolsEnabled) ? toolsEnabled : TOOLS);
  const problems = enabled.unknown.map((t) => `tools_enabled: невідомий інструмент '${t}'`);
  if (Array.isArray(toolsEnabled) && !toolsEnabled.length) problems.push('tools_enabled порожній');
  const available = enabled.tools.filter((t) => tools[t]?.found && tools[t]?.flagsOk !== false && tools[t]?.authorized !== false);
  if (Array.isArray(toolsEnabled)) {
    for (const t of enabled.tools) {
      if (!available.includes(t)) problems.push(`tools_enabled: інструмент '${t}' недоступний (наявність, прапорці або авторизація)`);
    }
  }
  const changes = [];
  const warnings = [];
  const roles = {};
  if (!available.length) return {
    available, roles: preferred, changes, warnings: ['no supported tool found'], problems,
    weakIndependence: false, weakRoles: [], mitigations: [], reportBadge: '', recommendations: [],
  };
  const desired = { ...Object.fromEntries(ROLES.map((r) => [r, undefined])), ...preferred };
  for (const [role, value] of Object.entries(desired)) {
    const want = canonicalTool(value);
    if (available.includes(want)) { roles[role] = want; continue; }
    const order = FALLBACK[role] ?? FALLBACK.default;
    const pick = order.find((t) => available.includes(t));
    roles[role] = pick;
    changes.push({ role, from: want, to: pick });
  }
  const testProt = protectedDirs(dirs.test_dirs);
  const protectedRole = { dev: ['code_dirs', protectedDirs(dirs.code_dirs)], qa_design: ['test_dirs', testProt] };
  for (const [role, [key, prot]] of Object.entries(protectedRole)) {
    if (roles[role] !== 'codex' || !prot.length) continue;
    const keep = confirmed && canonicalTool(preferred?.[role]) === 'codex'
      && (role === 'dev' || roles.dev !== 'codex');
    if (keep) {
      warnings.push(role === 'dev'
        ? `protected_paths: code_dirs (${prot.join(', ')}) закриті для запису з sandbox codex (.agents/.git); роль dev лишається на codex, бо мапу ролей підтверджено (roles_confirmed і roles_signature). Протокол implementation.patch: codex віддає implementation.patch у каталозі задачі, диригент застосовує його (git apply), запускає тести й guard та сам комітить`
        : `protected_paths: test_dirs (${prot.join(', ')}) закриті для запису з sandbox codex (.agents/.git); роль qa_design лишається на codex, бо мапу ролей підтверджено. Протокол патча тестів: codex віддає tests.patch у каталозі задачі, диригент застосовує його, перевіряє guard --tests-only, блокує тести (lock-tests), один раз запускає нові тести й сам комітить`);
      continue;
    }
    const other = FALLBACK[role].find((t) => available.includes(t) && t !== 'codex' && (role === 'dev' || t !== roles.dev))
      ?? FALLBACK[role].find((t) => available.includes(t) && t !== 'codex');
    if (other) {
      changes.push({ role, from: 'codex', to: other });
      roles[role] = other;
      warnings.push(`protected_paths: ${key} (${prot.join(', ')}) лежать у каталозі, закритому для запису з sandbox codex; роль ${role} переведено з codex на ${other}`);
    } else {
      warnings.push(`protected_paths: ${key} (${prot.join(', ')}) закриті для запису з sandbox codex (.agents/.git), а іншого інструмента немає; роль ${role} лишається на codex: протокол передачі патча — codex віддає implementation.patch, диригент застосовує його, запускає selftest і guard та сам комітить`);
    }
  }
  for (const role of ['review', 'qa_design', 'qa_run']) {
    if (roles[role] !== roles.dev) continue;
    const other = FALLBACK[role].find((t) => available.includes(t) && t !== roles.dev
      && !(role === 'qa_design' && testProt.length && t === 'codex'));
    if (other) {
      changes.push({ role, from: roles[role], to: other });
      roles[role] = other;
    }
  }
  const independence = evaluateIndependence(roles);
  if (independence.weakIndependence) warnings.push(independence.reportBadge);
  const recommendations = recommendRoles(preferred, roles, available, dirs);
  return { available, roles, changes, warnings, problems, ...independence, recommendations };
}

/** Advice is separate from availability repairs and never changes the proposed role map. */
function recommendRoles(preferred, roles, available, dirs) {
  const recommendations = [];
  const independentRoles = ['review', 'qa_design', 'qa_run'];
  for (const role of ROLES) {
    const current = roles[role];
    const target = DEFAULT_ROLES[role];
    if (current === target || canonicalTool(preferred?.[role]) !== current || !available.includes(target)) continue;
    if (independentRoles.includes(role) && target === roles.dev) continue;
    if (role === 'dev' && independentRoles.some((r) => roles[r] === target)) continue;
    const dirsForRole = role === 'dev' ? dirs.code_dirs : role === 'qa_design' ? dirs.test_dirs : [];
    if (target === 'codex' && protectedDirs(dirsForRole).length) continue;
    recommendations.push({
      role, from: current, to: target,
      message: `${role}: зараз ${current}, рекомендовано ${target} (нові дефолти модуля). doctor --apply цього не застосовує; як перейти вручну — README.md, розділ «Перехід наявного проєкту на нові дефолти».`,
    });
  }
  return recommendations;
}

/** Entries of a directory list that codex cannot write in workspace-write mode (.agents, .git). */
function protectedDirs(list) {
  return (Array.isArray(list) ? list : []).filter((d) => /^(\.\/)?\.(agents|git)(\/|$)/.test(d));
}

export function evaluateIndependence(roles) {
  const weakRoles = ['review', 'qa_design', 'qa_run'].filter((r) => roles[r] && canonicalTool(roles[r]) === canonicalTool(roles.dev));
  const mitigations = weakRoles.length ? [
    'Свіжий процес без контексту dev для кожної ролі, що збіглася',
    'Інша модель, якщо команда має плейсхолдер {model}; інакше пропустити без помилки',
    'Перевірка за чеклистом і diff',
    'Активні lock-tests і guard',
  ] : [];
  return {
    weakIndependence: weakRoles.length > 0, weakRoles, mitigations,
    reportBadge: weakRoles.length ? `weak independence: dev (${roles.dev}) збігається з ${weakRoles.join(', ')}. Пом’якшення: ${mitigations.join('; ')}.` : '',
  };
}

export function checkEntryPoints(rootDir, toolsEnabled) {
  const enabled = normalizeTools(toolsEnabled ?? TOOLS);
  const missing = [];
  const problems = enabled.unknown.map((t) => `tools_enabled: невідомий інструмент '${t}'`);
  for (const tool of enabled.tools) {
    const file = `${tool === 'claude' ? '.claude' : '.agents'}/skills/deliver/SKILL.md`;
    if (existsSync(resolve(rootDir, file))) continue;
    if (!missing.includes(file)) missing.push(file);
    problems.push(`немає точки входу для ${tool}: ${file}`);
  }
  return { ok: problems.length === 0, missing, problems };
}

export function detectConductor(cfg, env = process.env) {
  if (cfg.conductor != null) return normalizeTools([cfg.conductor]).tools[0] ?? null;
  return env.CLAUDECODE === '1' || env.CLAUDE_CODE_SESSION_ID ? 'claude' : null;
}

export function resolveCommand(tool, cfg, { conductor = detectConductor(cfg) } = {}) {
  tool = canonicalTool(tool);
  if (cfg.tools_enabled !== undefined
    && (!Array.isArray(cfg.tools_enabled) || !normalizeTools(cfg.tools_enabled).tools.includes(tool))) return null;
  if (tool === 'claude') {
    return canonicalTool(conductor) === 'claude' ? 'subagent' : cfg.commands?.claude_headless ?? 'claude -p "{prompt}"';
  }
  return cfg.commands?.[tool] ?? null;
}

export function rolesSignature(cfg) {
  const tools = Array.isArray(cfg.tools_enabled) ? normalizeTools(cfg.tools_enabled).tools.slice().sort() : null;
  const roles = Object.fromEntries(Object.entries(cfg.roles ?? {}).sort(([a], [b]) => a.localeCompare(b))
    .map(([role, tool]) => [role, canonicalTool(tool)]));
  return createHash('sha1').update(JSON.stringify({ tools, roles })).digest('hex');
}

// ---------------------------------------------------------------- permissions

function firstWords(cmd, n = 3) {
  return cmd.replace(/\{[^}]+\}/g, '').trim().split(/\s+/).slice(0, n).join(' ');
}

function testCommandPrefixes(cfg) {
  const t = cfg.test ?? {};
  const prefixes = new Set();
  for (const c of Object.values(t.commands ?? {})) {
    if (!c) continue;
    prefixes.add(t.exec_prefix ? t.exec_prefix : firstWords(c, 3));
  }
  return [...prefixes];
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '\\-');
}

const SAFE_SUBCOMMANDS = ['validate', 'guard', 'check-output', 'detect', 'selftest'];
export const SUBCOMMANDS = ['export', 'upgrade', 'migrate-config', 'selftest', 'doctor', 'perms', 'check-output', 'config', 'detect', 'init-config', 'validate', 'lock-tests', 'guard', 'install'];
const MUTATING_SUBCOMMANDS = SUBCOMMANDS.filter((s) => !SAFE_SUBCOMMANDS.includes(s));

function agySettingsFile() {
  return process.env.DELIVERY_AGY_SETTINGS || resolve(homedir(), '.gemini/antigravity-cli/settings.json');
}

/** A path entry naming a single file: no trailing slash, not an existing directory, has an extension. */
function isFileEntry(d, rootDir = root) {
  if (d.endsWith('/')) return false;
  const abs = resolve(rootDir, d);
  if (existsSync(abs)) return !statSync(abs).isDirectory();
  return /[^/]\.[^/.]+$/.test(d);
}

function agyRule(prefix, win) {
  return win ? `command(regex:${escapeRegex(prefix)}( .*)?)` : `command(${prefix})`;
}

export function proposePermissions(cfg, roles = cfg.roles, { conductor = null, rootDir = root, agyFile = agySettingsFile() } = {}) {
  roles = Object.fromEntries(Object.entries(roles ?? {}).map(([role, tool]) => [role, canonicalTool(tool)]));
  const used = new Set(Object.values(roles));
  const win = WIN;
  const claudeConductor = canonicalTool(conductor) === 'claude';
  const claudeAllow = [
    'Bash(node .agents/delivery/delivery.mjs:*)',
    ...(used.has('codex') ? ['Bash(codex exec:*)'] : []),
    ...(used.has('antigravity') ? ['Bash(agy -p:*)'] : []),
    'Bash(git switch:*)', 'Bash(git add:*)', 'Bash(git commit:*)',
    'Bash(git diff:*)', 'Bash(git status:*)', 'Bash(git log:*)',
    ...testCommandPrefixes(cfg).map((p) => `Bash(${p}:*)`),
  ];
  const secrets = (cfg.forbidden_paths ?? [])
    .map((p) => p.replace(/^\*\*\//, ''))
    .filter((p) => !/[*?]/.test(p));
  const agyPath = (entry, isDir = false) => toPosix(resolve(rootDir, entry)).replace(/\/*$/, isDir ? '/' : '');
  const dirRule = (d) => agyPath(d, !isFileEntry(d, rootDir));
  const testDirs = (cfg.test_dirs ?? []).map(dirRule);
  const codeDirs = (cfg.code_dirs ?? []).map(dirRule);
  const agyAllow = [
    'read_file(*)',
    ...(roles.qa_design === 'antigravity' || roles.dev === 'antigravity' ? testDirs.map((d) => `write_file(${d})`) : []),
    ...(roles.dev === 'antigravity' ? codeDirs.map((d) => `write_file(${d})`) : []),
    `write_file(${agyPath('.work', true)})`,
  ];
  const denyCmds = ['sudo', 'rm -rf', 'git push', 'git reset', 'git checkout', 'git clean'];
  const agyDeny = [
    ...denyCmds.map((p) => agyRule(p, win)),
    'command(regex:.*(migrate|db\\-fresh|db_fresh|schema:drop|flush).*)',
    ...MUTATING_SUBCOMMANDS.map((sub) => `command(regex:.*delivery\\.mjs\\s+${escapeRegex(sub)}(\\s.*)?)`),
    `write_file(${agyPath('.git', true)})`,
    ...secrets.flatMap((p) => [`read_file(${agyPath(p)})`, `write_file(${agyPath(p)})`]),
  ];
  const proposal = {};
  if (used.has('claude') || claudeConductor) proposal.claude = { file: resolve(rootDir, '.claude/settings.local.json'), allow: [...new Set(claudeAllow)], deny: [] };
  if (used.has('antigravity')) proposal.antigravity = {
    file: agyFile, allow: [...new Set(agyAllow)], deny: [...new Set(agyDeny)],
    settings: { toolPermission: 'proceed-in-sandbox', enableTerminalSandbox: true },
    dockerWarning: cfg.test?.env === 'docker'
      ? 'test.env = docker: Docker і мережа можуть не працювати в sandbox agy, тож ролі QA на antigravity можуть повернути blocked. Модуль не додає правил запуску поза sandbox; за потреби налаштуйте це вручну.' : null,
    note: 'Sandbox mode: commands run in the agy terminal sandbox without a command allowlist; file rules use absolute paths of this project (relative rules break the sandbox).',
  };
  return proposal;
}

function mergeList(a = [], b = []) {
  return [...new Set([...a, ...b])];
}

function isRelativeFileRule(rule) {
  const match = rule.match(/^(?:read_file|write_file)\((.*)\)$/);
  return !!match && match[1] !== '*' && !match[1].startsWith('/') && !/^[A-Za-z]:[\\/]/.test(match[1]);
}

export function permsPlan(cfg, only, { rootDir = root, agyFile } = {}) {
  const proposal = proposePermissions(cfg, cfg.roles, { conductor: detectConductor(cfg), rootDir, agyFile });
  const targets = [];
  for (const [tool, p] of Object.entries(proposal)) {
    if (only && !only.includes(tool)) continue;
    const current = existsSync(p.file) ? readJson(p.file) ?? {} : {};
    const curAllow = current.permissions?.allow ?? [];
    const curDeny = current.permissions?.deny ?? [];
    const relativeRules = p.settings ? [
      ...curAllow.filter(isRelativeFileRule).map((rule) => ({ list: 'allow', rule })),
      ...curDeny.filter(isRelativeFileRule).map((rule) => ({ list: 'deny', rule })),
    ] : [];
    targets.push({
      tool, file: p.file, exists: existsSync(p.file), note: p.note ?? null,
      addAllow: p.allow.filter((r) => !curAllow.includes(r)),
      addDeny: p.deny.filter((r) => !curDeny.includes(r)),
      current,
      proposalAllow: p.allow, proposalDeny: p.deny,
      ...(p.settings ? {
        settings: p.settings,
        settingsDiff: Object.entries(p.settings).filter(([key, value]) => current[key] !== value)
          .map(([key, proposed]) => ({ key, current: current[key] ?? null, proposed })),
        relativeRules,
        relativeRulesNote: relativeRules.length
          ? 'Глобальний файл agy містить відносні файлові правила (relativeRules). Поки вони є, sandbox agy не запускає жодної команди (sandbox configuration error: non-absolute file path) у всіх проєктах машини. Зробіть кожне правило абсолютним для свого проєкту або видаліть його вручну; модуль їх не змінює. До того perms --apply додає абсолютні правила цього проєкту, але не вмикає sandbox і не ставить permissions_confirmed; ролі на antigravity без списку дозволених команд не запустять жодної команди.' : null,
        dockerWarning: p.dockerWarning,
      } : {}),
    });
  }
  return targets;
}

export function permsApply(targets) {
  const applied = [];
  const notApplied = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const t of targets) {
    const wantSettings = (t.settingsDiff ?? []).length > 0;
    // Relative rules also invalidate an already enabled sandbox; do not confirm it.
    const blocked = (t.relativeRules ?? []).length > 0;
    const writeSettings = wantSettings && !blocked;
    if (blocked) notApplied.push({
      tool: t.tool, file: t.file, settings: t.settingsDiff.map((d) => d.key),
      reason: 'relative file rules remain in the global agy file; the sandbox would fail with non-absolute file path. Fix them by hand (see relativeRules) and run perms --apply again.',
      relativeRules: t.relativeRules,
    });
    if (!t.addAllow.length && !t.addDeny.length && !writeSettings) continue;
    let backup = null;
    if (t.exists) {
      backup = `${t.file}.bak-delivery-${stamp}`;
      copyFileSync(t.file, backup);
    } else {
      mkdirSync(dirname(t.file), { recursive: true });
    }
    const next = { ...t.current, permissions: { ...(t.current.permissions ?? {}) } };
    next.permissions.allow = mergeList(next.permissions.allow, t.proposalAllow);
    if (t.proposalDeny.length) next.permissions.deny = mergeList(next.permissions.deny, t.proposalDeny);
    if (writeSettings) Object.assign(next, t.settings);
    writeFileSync(t.file, JSON.stringify(next, null, 2) + '\n');
    applied.push({ tool: t.tool, file: t.file, backup, addedAllow: t.addAllow.length, addedDeny: t.addDeny.length, settings: writeSettings ? t.settings : null });
  }
  return { applied, notApplied, allApplied: notApplied.length === 0 };
}

const WRITE_FAILURE_RE = /\bEROFS\b|read-only file system|(?:unable|cannot|can't|failed) to create[^\n]{0,200}index\.lock|\bAccess is denied\b|\b(?:error|fatal|failed)\b[^\n]{0,60}access denied/i;

/** agy-style output: first non-empty line is a JSON object with a "response" key (response text may quote error words as data). */
function isJsonEnvelope(text) {
  const line = text.split(/\r?\n/).find((l) => l.trim());
  try { const o = line && JSON.parse(line); return !!o && typeof o === 'object' && 'response' in o; } catch { return false; }
}

/** Detect silent failures of non-interactive tools: exit code 0 but nothing done. */
export function checkToolOutput(text) {
  const reasons = [];
  if (!text.trim()) reasons.push('empty output');
  if (/jetski: no output produced|auto-denied/i.test(text)) reasons.push('permission was auto-denied (headless mode cannot prompt); add an allow rule');
  const denied = text.match(/"denied_actions"\s*:\s*\[([^\]]+)\]/);
  if (denied) reasons.push(`denied_actions: ${denied[1].trim().slice(0, 200)}`);
  if (/"response"\s*:\s*""/.test(text)) reasons.push('empty response');
  if (/sandbox configuration error[^\n]{0,200}non-absolute file path/i.test(text)) reasons.push('agy sandbox configuration error: a relative file rule in the global agy settings (non-absolute file path) stops every command; run perms and fix the listed relativeRules by hand');
  if (!isJsonEnvelope(text) && WRITE_FAILURE_RE.test(text)) reasons.push('write failure: the tool could not write to the repository (sandbox protects .agents and .git: access denied, index.lock or read-only); use the implementation.patch protocol and let the conductor commit');
  if (/command not found|is not recognized as the name of a cmdlet/i.test(text)) reasons.push('a command used by the tool is not available');
  return { ok: reasons.length === 0, reasons };
}

export { TOOLS };
