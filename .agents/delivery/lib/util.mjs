// Shared helpers: paths, JSON output, process execution, glob matching. No external dependencies.
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const moduleDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const root = resolve(moduleDir, '..', '..');

export function out(data, code = 0) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  process.exit(code);
}

export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function loadConfig() {
  const file = resolve(moduleDir, 'project.json');
  const cfg = existsSync(file) ? readJson(file) : null;
  if (!cfg || typeof cfg !== 'object') {
    out({ ok: false, errors: ['project.json missing or invalid'] }, 1);
  }
  return cfg;
}

export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: root, shell: false, ...opts });
  return { code: r.status ?? (r.error ? 127 : 1), stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

export function git(args) {
  const r = run('git', ['-C', root, ...args]);
  return { code: r.code, lines: r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean), stderr: r.stderr.trim() };
}

export function toPosix(p) {
  return p.split(sep).join('/');
}

export function relPosix(p) {
  return toPosix(relative(root, p));
}

export function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$');
}

export function underAny(file, dirs) {
  return dirs.some((d) => file.startsWith(d.replace(/\/+$/, '') + '/'));
}

/** Hash of file content with line endings normalised, so CRLF/LF conversion by git does not change it. */
export function normalizedHash(file) {
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return createHash('sha1').update(text).digest('hex');
}

/** Files changed against `base` (tracked changes plus untracked, not ignored). */
export function changedFiles(base) {
  const diff = git(['diff', '--name-only', base]);
  if (diff.code !== 0) {
    out({ ok: false, errors: ['git diff failed: ' + (diff.stderr || diff.lines.join(' '))] }, 1);
  }
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  return [...new Set([...diff.lines, ...(untracked.code === 0 ? untracked.lines : [])])];
}
