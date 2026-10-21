// Environment checks (doctor), role remapping and permission proposals (perms).
import { existsSync, statSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { root, readJson, run } from './util.mjs';

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
  qa_design: ['antigravity', 'claude', 'codex'],
  qa_run: ['antigravity', 'claude', 'codex'],
  review: ['claude', 'antigravity', 'codex'],
  default: ['claude', 'antigravity', 'codex'],
};

/** Propose all roles using the enabled, usable tools, separating review and QA from dev. */
export function proposeRoles(preferred, tools, toolsEnabled, dirs = {}) {
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
    weakIndependence: false, weakRoles: [], mitigations: [], reportBadge: '',
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
  return { available, roles, changes, warnings, problems, ...independence };
}

/** Entries of a directory list that codex cannot write in workspace-write mode (.agents, .git). */
function protectedDirs(list) {
  return (Array.isArray(list) ? list : []).filter((d) => /^(\.\/)?\.(agents|git)(\/|$)/.test(d));
}

export function evaluateIndependence(roles) {
  const weakRoles = ['review', 'qa_design', 'qa_run'].filter((r) => roles[r] && roles[r] === roles.dev);
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

/** A path entry naming a single file: no trailing slash, not an existing directory, has an extension. */
function isFileEntry(d) {
  if (d.endsWith('/')) return false;
  const abs = resolve(root, d);
  if (existsSync(abs)) return !statSync(abs).isDirectory();
  return /[^/]\.[^/.]+$/.test(d);
}

function agyRule(prefix, win) {
  return win ? `command(regex:${escapeRegex(prefix)}( .*)?)` : `command(${prefix})`;
}

export function proposePermissions(cfg, roles = cfg.roles, { conductor = null } = {}) {
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
  const readCmds = ['git status', 'git diff', 'git log', 'git show', 'git ls-files', 'git rev-parse', 'git branch', 'git grep'];
  const shellRead = WIN ? ['Get-ChildItem', 'Get-Content', 'Select-String', 'Set-Location', 'Test-Path', 'rg', 'ls']
    : ['ls', 'cat', 'rg', 'grep', 'find', 'pwd'];
  const secrets = (cfg.forbidden_paths ?? [])
    .map((p) => p.replace(/^\*\*\//, ''))
    .filter((p) => !/[*?]/.test(p));
  const dirRule = (d) => (isFileEntry(d) ? d : d.replace(/\/*$/, '/'));
  const testDirs = (cfg.test_dirs ?? []).map(dirRule);
  const codeDirs = (cfg.code_dirs ?? []).map(dirRule);
  const agyAllow = [
    ...[...readCmds, ...testCommandPrefixes(cfg), ...(cfg.test?.commands?.lint ? [firstWords(cfg.test.commands.lint, 2)] : [])]
      .map((p) => agyRule(p, win)),
    ...shellRead.map((p) => agyRule(p, win)),
    ...SAFE_SUBCOMMANDS.map((sub) => agyRule(`node .agents/delivery/delivery.mjs ${sub}`, win)),
    'read_file(*)',
    ...(roles.qa_design === 'antigravity' || roles.dev === 'antigravity' ? testDirs.map((d) => `write_file(${d})`) : []),
    ...(roles.dev === 'antigravity' ? codeDirs.map((d) => `write_file(${d})`) : []),
    'write_file(.work/)',
  ];
  const denyCmds = ['sudo', 'rm -rf', 'git push', 'git reset', 'git checkout', 'git clean'];
  const agyDeny = [
    ...denyCmds.map((p) => agyRule(p, win)),
    'command(regex:.*(migrate|db\\-fresh|db_fresh|schema:drop|flush).*)',
    'write_file(.git/)',
    ...secrets.flatMap((p) => [`read_file(${p})`, `write_file(${p})`]),
  ];
  const proposal = {};
  if (used.has('claude') || claudeConductor) proposal.claude = { file: resolve(root, '.claude/settings.local.json'), allow: [...new Set(claudeAllow)], deny: [] };
  if (used.has('antigravity')) proposal.antigravity = {
    file: resolve(homedir(), '.gemini/antigravity-cli/settings.json'), allow: [...new Set(agyAllow)], deny: [...new Set(agyDeny)],
    note: win ? 'Windows: regex-form rules (plain command(prefix) rules did not match on agy 1.4.4).' : 'Non-Windows: plain command(prefix) rules; verify with a probe run, the regex form may be needed.',
  };
  return proposal;
}

function mergeList(a = [], b = []) {
  return [...new Set([...a, ...b])];
}

export function permsPlan(cfg, only) {
  const proposal = proposePermissions(cfg, cfg.roles, { conductor: detectConductor(cfg) });
  const targets = [];
  for (const [tool, p] of Object.entries(proposal)) {
    if (only && !only.includes(tool)) continue;
    const current = existsSync(p.file) ? readJson(p.file) ?? {} : {};
    const curAllow = current.permissions?.allow ?? [];
    const curDeny = current.permissions?.deny ?? [];
    targets.push({
      tool, file: p.file, exists: existsSync(p.file), note: p.note ?? null,
      addAllow: p.allow.filter((r) => !curAllow.includes(r)),
      addDeny: p.deny.filter((r) => !curDeny.includes(r)),
      current,
      proposalAllow: p.allow, proposalDeny: p.deny,
    });
  }
  return targets;
}

export function permsApply(targets) {
  const applied = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const t of targets) {
    if (!t.addAllow.length && !t.addDeny.length) continue;
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
    writeFileSync(t.file, JSON.stringify(next, null, 2) + '\n');
    applied.push({ tool: t.tool, file: t.file, backup, addedAllow: t.addAllow.length, addedDeny: t.addDeny.length });
  }
  return applied;
}

/** Detect silent failures of non-interactive tools: exit code 0 but nothing done. */
export function checkToolOutput(text) {
  const reasons = [];
  if (!text.trim()) reasons.push('empty output');
  if (/jetski: no output produced|auto-denied/i.test(text)) reasons.push('permission was auto-denied (headless mode cannot prompt); add an allow rule');
  const denied = text.match(/"denied_actions"\s*:\s*\[([^\]]+)\]/);
  if (denied) reasons.push(`denied_actions: ${denied[1].trim().slice(0, 200)}`);
  if (/"response"\s*:\s*""/.test(text)) reasons.push('empty response');
  if (/access (is )?denied|index\.lock|read-only|EROFS/i.test(text)) reasons.push('write failure: the tool could not write to the repository (sandbox protects .agents and .git: access denied, index.lock or read-only); use the implementation.patch protocol and let the conductor commit');
  if (/command not found|is not recognized as the name of a cmdlet/i.test(text)) reasons.push('a command used by the tool is not available');
  return { ok: reasons.length === 0, reasons };
}

export { TOOLS };
