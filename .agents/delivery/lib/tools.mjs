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
  const problems = enabled.unknown.map((t) => `tools_enabled: unknown tool '${t}'`);
  if (Array.isArray(toolsEnabled) && !toolsEnabled.length) problems.push('tools_enabled is empty');
  const available = enabled.tools.filter((t) => tools[t]?.found && tools[t]?.flagsOk !== false && tools[t]?.authorized !== false);
  if (Array.isArray(toolsEnabled)) {
    for (const t of enabled.tools) {
      if (!available.includes(t)) problems.push(`tools_enabled: tool '${t}' is not available (not found, unsupported flags or not authorized)`);
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
        ? `protected_paths: code_dirs (${prot.join(', ')}) are not writable from the codex sandbox (.agents/.git); dev stays on codex because the role map is confirmed (roles_confirmed and roles_signature). implementation.patch protocol: codex returns implementation.patch in the task directory, the conductor applies it (git apply), runs the tests and guard and commits`
        : `protected_paths: test_dirs (${prot.join(', ')}) are not writable from the codex sandbox (.agents/.git); qa_design stays on codex because the role map is confirmed. Test patch protocol: codex returns tests.patch in the task directory, the conductor applies it, checks guard --tests-only, locks the tests (lock-tests), runs the new tests once and commits`);
      continue;
    }
    const other = FALLBACK[role].find((t) => available.includes(t) && t !== 'codex' && (role === 'dev' || t !== roles.dev))
      ?? FALLBACK[role].find((t) => available.includes(t) && t !== 'codex');
    if (other) {
      changes.push({ role, from: 'codex', to: other });
      roles[role] = other;
      warnings.push(`protected_paths: ${key} (${prot.join(', ')}) are in a directory the codex sandbox cannot write; role ${role} moved from codex to ${other}`);
    } else {
      warnings.push(`protected_paths: ${key} (${prot.join(', ')}) are not writable from the codex sandbox (.agents/.git) and no other tool is available; role ${role} stays on codex with the patch protocol: codex returns implementation.patch, the conductor applies it, runs selftest and guard and commits`);
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
      message: `${role}: now ${current}, recommended ${target} (new module defaults). doctor --apply does not apply this; to switch by hand see README.md, section "Moving an existing project to the new defaults".`,
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
    'A fresh process without dev context for each matching role',
    'A different model when the command has a {model} placeholder; otherwise skip without error',
    'Check against the checklist and the diff',
    'Active lock-tests and guard',
  ] : [];
  return {
    weakIndependence: weakRoles.length > 0, weakRoles, mitigations,
    reportBadge: weakRoles.length ? `weak independence: dev (${roles.dev}) shares its tool with ${weakRoles.join(', ')}. Mitigations: ${mitigations.join('; ')}.` : '',
  };
}

export function checkEntryPoints(rootDir, toolsEnabled) {
  const enabled = normalizeTools(toolsEnabled ?? TOOLS);
  const missing = [];
  const problems = enabled.unknown.map((t) => `tools_enabled: unknown tool '${t}'`);
  for (const tool of enabled.tools) {
    const file = `${tool === 'claude' ? '.claude' : '.agents'}/skills/deliver/SKILL.md`;
    if (existsSync(resolve(rootDir, file))) continue;
    if (!missing.includes(file)) missing.push(file);
    problems.push(`no entry point for ${tool}: ${file}`);
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

/** Data dir of interactive agy CLI sessions; delivery never writes its settings. */
export const AGY_GLOBAL_DIR = 'antigravity-cli';

/**
 * System commands denied as a second line of defence. The agy terminal sandbox on Windows hides host
 * processes (agy 1.4.5: a sandboxed command sees only its own processes), but agy runs a command outside
 * the sandbox once a human approves it, and sessions may run without the sandbox: on 2026-10-22 an
 * unsandboxed agy session ran `Stop-Process -Name git, bash -Force` and killed every git and bash on the
 * machine. Verified on agy 1.4.5: a `.*...*` rule matches anywhere in the line, also after `|`,
 * inside `cmd /c "..."` and `& { ... }`; `(?i:...)` ignores case.
 */
export const SYSTEM_DENY_RULES = [
  String.raw`command(regex:.*(?i:\b(stop-process|spps|taskkill|tskill|pskill|kill|pkill|killall|wmic|invoke-cimmethod|invoke-wmimethod)\b).*)`,
  String.raw`command(regex:.*(?i:\b(stop-computer|restart-computer|logoff|reboot|poweroff)\b|\bshutdown(\.exe)?\s+([/-][srlhpaf]\b|now\b)).*)`,
  String.raw`command(regex:.*(?i:\b(stop-service|restart-service|suspend-service|set-service|new-service|remove-service|systemctl|launchctl)\b|\bsc(\.exe)?\s+(stop|delete|config|create|pause|failure)\b|\bnet(\.exe)?\s+(stop|start|user|localgroup)\b).*)`,
  String.raw`command(regex:.*(?i:\b(schtasks|register-scheduledtask|unregister-scheduledtask|set-scheduledtask|crontab)\b).*)`,
  String.raw`command(regex:.*(?i:\breg(\.exe)?\s+(add|delete|import|load|unload|restore|copy)\b|\b(set-itemproperty|new-itemproperty|remove-itemproperty|rename-itemproperty)\b|\b(hklm|hkcu|hkcr|hku|hkcc):|registry::).*)`,
  String.raw`command(regex:.*(?i:\b(netsh|bcdedit|diskpart|format-volume|set-executionpolicy|add-mppreference|set-mppreference|wsl|takeown|icacls)\b|-verb\s+runas\b).*)`,
];

/** Profile name from `--app_data_dir=<name>` in commands.antigravity, or null. */
export function agyProfileDir(cfg) {
  const m = String(cfg?.commands?.antigravity ?? '').match(/--app_data_dir[=\s]+"?([^"\s]+)"?/);
  return m ? m[1] : null;
}

/** Why this project's delivery runs of agy have no own profile, or null when they have one. */
export function agyProfileProblem(cfg) {
  const dir = agyProfileDir(cfg);
  if (!dir) return 'commands.antigravity has no --app_data_dir: agy roles would run with the global agy settings of every interactive session. Run migrate-config (it adds --app_data_dir=antigravity-delivery-<project>), then perms.';
  if (dir === AGY_GLOBAL_DIR || /[\\/:]|\.\./.test(dir)) return `commands.antigravity: --app_data_dir=${dir} is not a delivery profile name; use antigravity-delivery-<project>.`;
  return null;
}

/** Model of interactive agy sessions (global settings), or null; never for the global file itself. */
function agyGlobalModel(agyFile) {
  const globalFile = resolve(homedir(), '.gemini', AGY_GLOBAL_DIR, 'settings.json');
  if (!agyFile || resolve(agyFile) === globalFile || !existsSync(globalFile)) return null;
  const model = readJson(globalFile)?.model;
  return typeof model === 'string' && model ? model : null;
}

function agySettingsFile(cfg) {
  if (process.env.DELIVERY_AGY_SETTINGS) return process.env.DELIVERY_AGY_SETTINGS;
  return agyProfileProblem(cfg) ? null : resolve(homedir(), '.gemini', agyProfileDir(cfg), 'settings.json');
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

export function proposePermissions(cfg, roles = cfg.roles, { conductor = null, rootDir = root, agyFile = agySettingsFile(cfg) } = {}) {
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
    ...SYSTEM_DENY_RULES,
    `write_file(${agyPath('.git', true)})`,
    ...secrets.flatMap((p) => [`read_file(${agyPath(p)})`, `write_file(${agyPath(p)})`]),
  ];
  const proposal = {};
  if (used.has('claude') || claudeConductor) proposal.claude = { file: resolve(rootDir, '.claude/settings.local.json'), allow: [...new Set(claudeAllow)], deny: [] };
  if (used.has('antigravity') && !agyFile) proposal.antigravity = {
    file: null, allow: [], deny: [], problem: agyProfileProblem(cfg) ?? 'no agy settings file for delivery',
  };
  else if (used.has('antigravity')) proposal.antigravity = {
    file: agyFile, allow: [...new Set(agyAllow)], deny: [...new Set(agyDeny)],
    settings: { toolPermission: 'proceed-in-sandbox', enableTerminalSandbox: true },
    // A new profile has no model and agy would fall back to its default one: keep the model chosen for interactive agy.
    inheritModel: agyGlobalModel(agyFile),
    dockerWarning: cfg.test?.env === 'docker'
      ? 'test.env = docker: Docker and network may not work in the agy sandbox, so QA roles on antigravity may return blocked. The module adds no rules for running outside the sandbox; configure that by hand if needed.' : null,
    note: 'Own agy profile of this project (--app_data_dir in commands.antigravity): the global agy settings of interactive sessions are not touched. Sandbox mode: commands run in the agy terminal sandbox without a command allowlist; system commands (process kill, power, services, scheduled tasks, registry) are also denied, for commands agy runs outside the sandbox; file rules use absolute paths of this project (relative rules break the sandbox).',
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
    if (!p.file) {
      targets.push({ tool, file: null, exists: false, problem: p.problem, addAllow: [], addDeny: [], current: {}, proposalAllow: [], proposalDeny: [] });
      continue;
    }
    const current = existsSync(p.file) ? readJson(p.file) ?? {} : {};
    const curAllow = current.permissions?.allow ?? [];
    const curDeny = current.permissions?.deny ?? [];
    const settings = p.settings && p.inheritModel && !current.model ? { ...p.settings, model: p.inheritModel } : p.settings;
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
      ...(settings ? {
        settings,
        settingsDiff: Object.entries(settings).filter(([key, value]) => current[key] !== value)
          .map(([key, proposed]) => ({ key, current: current[key] ?? null, proposed })),
        relativeRules,
        relativeRulesNote: relativeRules.length
          ? 'The agy settings file of this profile has relative file rules (relativeRules). While they exist, the agy sandbox runs no command (sandbox configuration error: non-absolute file path). Make each rule absolute or delete it by hand; the module does not change them. Until then perms --apply adds the absolute rules of this project but does not enable the sandbox or set permissions_confirmed; roles on antigravity without a command allowlist cannot run any command.' : null,
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
    if (t.problem) {
      notApplied.push({ tool: t.tool, file: null, reason: t.problem });
      continue;
    }
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
  if (/sandbox configuration error[^\n]{0,200}non-absolute file path/i.test(text)) reasons.push('agy sandbox configuration error: a relative file rule in the agy settings of the delivery profile (non-absolute file path) stops every command; run perms and fix the listed relativeRules by hand');
  if (!isJsonEnvelope(text) && WRITE_FAILURE_RE.test(text)) reasons.push('write failure: the tool could not write to the repository (sandbox protects .agents and .git: access denied, index.lock or read-only); use the implementation.patch protocol and let the conductor commit');
  if (/command not found|is not recognized as the name of a cmdlet/i.test(text)) reasons.push('a command used by the tool is not available');
  return { ok: reasons.length === 0, reasons };
}

export { TOOLS };
