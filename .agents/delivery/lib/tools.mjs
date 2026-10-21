// Environment checks (doctor), role remapping and permission proposals (perms).
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { root, readJson, run } from './util.mjs';

const WIN = process.platform === 'win32';
const TOOLS = ['claude', 'codex', 'antigravity'];
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

/** Propose a role -> tool map using only available tools, keeping author != reviewer when possible. */
export function proposeRoles(preferred, tools) {
  const available = TOOLS.filter((t) => tools[t]?.found && tools[t]?.flagsOk !== false && tools[t]?.authorized !== false);
  const changes = [];
  const warnings = [];
  const roles = {};
  if (!available.length) return { available, roles: preferred, changes, warnings: ['no supported tool found'] };
  for (const [role, want] of Object.entries(preferred)) {
    if (available.includes(want)) { roles[role] = want; continue; }
    const order = FALLBACK[role] ?? FALLBACK.default;
    const pick = order.find((t) => available.includes(t));
    roles[role] = pick;
    changes.push({ role, from: want, to: pick });
  }
  if (roles.dev === roles.review) {
    const other = (FALLBACK.review).find((t) => available.includes(t) && t !== roles.dev);
    if (other) {
      changes.push({ role: 'review', from: roles.review, to: other });
      roles.review = other;
    } else {
      warnings.push(`only one tool available (${roles.dev}): reviewer and developer use the same tool; use a different model for the reviewer and treat the review as weaker`);
    }
  }
  return { available, roles, changes, warnings, weakIndependence: roles.dev === roles.review };
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

function agyRule(prefix, win) {
  return win ? `command(regex:${escapeRegex(prefix)}( .*)?)` : `command(${prefix})`;
}

export function proposePermissions(cfg) {
  const win = WIN;
  const claudeAllow = [
    'Bash(node .agents/delivery/delivery.mjs:*)',
    'Bash(codex exec:*)', 'Bash(agy -p:*)',
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
  const testDirs = (cfg.test_dirs ?? []).map((d) => d.replace(/\/*$/, '/'));
  const agyAllow = [
    ...[...readCmds, ...testCommandPrefixes(cfg), ...(cfg.test?.commands?.lint ? [firstWords(cfg.test.commands.lint, 2)] : [])]
      .map((p) => agyRule(p, win)),
    ...shellRead.map((p) => agyRule(p, win)),
    'read_file(*)',
    ...testDirs.map((d) => `write_file(${d})`),
    'write_file(.work/)',
  ];
  const denyCmds = ['sudo', 'rm -rf', 'git push', 'git reset', 'git checkout', 'git clean'];
  const agyDeny = [
    ...denyCmds.map((p) => agyRule(p, win)),
    'command(regex:.*(migrate|db\\-fresh|db_fresh|schema:drop|flush).*)',
    'write_file(.git/)',
    ...secrets.flatMap((p) => [`read_file(${p})`, `write_file(${p})`]),
  ];
  return {
    claude: { file: resolve(root, '.claude/settings.local.json'), allow: [...new Set(claudeAllow)], deny: [] },
    antigravity: { file: resolve(homedir(), '.gemini/antigravity-cli/settings.json'), allow: [...new Set(agyAllow)], deny: [...new Set(agyDeny)],
      note: win ? 'Windows: regex-form rules (plain command(prefix) rules did not match on agy 1.4.4).' : 'Non-Windows: plain command(prefix) rules; verify with a probe run, the regex form may be needed.' },
  };
}

function mergeList(a = [], b = []) {
  return [...new Set([...a, ...b])];
}

export function permsPlan(cfg, only) {
  const proposal = proposePermissions(cfg);
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
  if (/command not found|is not recognized as the name of a cmdlet/i.test(text)) reasons.push('a command used by the tool is not available');
  return { ok: reasons.length === 0, reasons };
}

export { TOOLS };
