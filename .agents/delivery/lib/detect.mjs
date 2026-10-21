// Stack, git, docker and test-command detection. Produces a draft project.json.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { moduleDir, root, readJson, git } from './util.mjs';

export const MODULE_VERSION = '0.2.0';

export const DEFAULT_ROLES = {
  ba: 'claude', teamlead: 'claude', architect: 'claude', qa_design: 'antigravity',
  dev: 'codex', review: 'claude', qa_run: 'antigravity', report: 'claude',
};
export const DEFAULT_COMMANDS = {
  codex: 'codex exec --sandbox workspace-write "{prompt}"',
  antigravity: 'agy -p "{prompt}" --output-format json --print-timeout 30m --effort high',
  claude: 'subagent',
};
export const DEFAULT_LIMITS = {
  max_iterations: 3, max_question_rounds: 2, max_back_to_ba: 1, max_po_rework: 2, max_questions: 7,
};
export const HUMAN_APPROVAL = ['migration', 'rbac', 'new_dependency', 'data_deletion'];

const APP_DIRS = ['.', 'src', 'app', 'backend', 'api', 'server'];

function rd(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

function loadProfiles() {
  const dir = resolve(moduleDir, 'profiles');
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(resolve(dir, f))).filter(Boolean);
}

function findFile(name) {
  for (const d of APP_DIRS) {
    const p = resolve(root, d, name);
    if (existsSync(p)) return { dir: d, path: p };
  }
  return null;
}

function manifests() {
  const composer = findFile('composer.json');
  const pkg = findFile('package.json');
  const composerData = composer ? readJson(composer.path) ?? {} : {};
  const pkgData = pkg ? readJson(pkg.path) ?? {} : {};
  const pyFiles = ['pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.py', 'manage.py']
    .map(findFile).filter(Boolean);
  const pyText = pyFiles.map((f) => (rd(f.path) ?? '').toLowerCase()).join('\n');
  return {
    composer, pkg, composerData, pkgData, pyFiles, pyText,
    composerDeps: { ...(composerData.require ?? {}), ...(composerData['require-dev'] ?? {}) },
    npmDeps: { ...(pkgData.dependencies ?? {}), ...(pkgData.devDependencies ?? {}) },
  };
}

function matches(cond, m) {
  if (cond.file) return !!findFile(cond.file);
  if (cond.composer) return cond.composer in m.composerDeps;
  if (cond.npm) return cond.npm in m.npmDeps;
  if (cond.py) return m.pyText.includes(cond.py.toLowerCase());
  return false;
}

function pickProfile(profiles, m) {
  const scored = profiles
    .filter((p) => p.id !== 'generic')
    .map((p) => {
      const hit = (p.detect?.any ?? []).filter((c) => matches(c, m));
      return { id: p.id, score: hit.length * (p.detect?.weight ?? 1), evidence: hit.map((c) => JSON.stringify(c)) };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  return {
    profile: best ? best.id : 'generic',
    evidence: best ? best.evidence : [],
    alternatives: scored.slice(1).map((s) => ({ id: s.id, score: s.score })),
  };
}

function gitInfo() {
  const top = git(['rev-parse', '--show-toplevel']);
  const norm = (p) => resolve(p).toLowerCase();
  const isRepo = top.code === 0 && norm(top.lines[0] ?? '') === norm(root);
  if (!isRepo) return { isRepo: false, baseBranch: null, branch: null, remote: null, host: null, dirty: 0 };
  let base = null;
  const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head.code === 0 && head.lines[0]) base = head.lines[0].replace(/^origin\//, '');
  if (!base) {
    for (const b of ['main', 'master']) {
      if (git(['show-ref', '--verify', '--quiet', `refs/heads/${b}`]).code === 0) { base = b; break; }
    }
  }
  const branch = git(['branch', '--show-current']).lines[0] ?? null;
  base = base ?? branch;
  const remote = git(['remote', 'get-url', 'origin']).lines[0] ?? null;
  const host = !remote ? null : /github\.com/i.test(remote) ? 'github' : /gitlab/i.test(remote) ? 'gitlab' : 'other';
  const dirty = git(['status', '--short']).lines.filter((l) => !/\.work\//.test(l)).length;
  return { isRepo, baseBranch: base, branch, remote, host, dirty };
}

function dockerInfo(profile) {
  const file = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']
    .find((f) => existsSync(resolve(root, f)));
  if (!file) return { compose: null, services: [], suggested: null };
  const text = rd(resolve(root, file)) ?? '';
  const block = text.split(/\r?\n/);
  const start = block.findIndex((l) => /^services:\s*$/.test(l));
  const services = [];
  if (start >= 0) {
    for (const l of block.slice(start + 1)) {
      if (/^\S/.test(l) && l.trim() !== '') break;
      const mm = l.match(/^ {2}([A-Za-z0-9_.-]+):\s*$/);
      if (mm) services.push(mm[1]);
    }
  }
  let suggested = null;
  for (const hint of profile.docker_service_hints ?? []) {
    suggested = services.find((s) => s.toLowerCase().includes(hint));
    if (suggested) break;
  }
  return { compose: file, services, suggested };
}

function existingDirs(list) {
  return list.filter((d) => existsSync(resolve(root, d))).map((d) => d.replace(/\/*$/, '/'));
}

function refineTestCommands(profile, m, appDir) {
  const cmds = { ...profile.test.commands };
  if (profile.id === 'yii2') {
    if (!('codeception/codeception' in m.composerDeps) && 'phpunit/phpunit' in m.composerDeps) {
      cmds.file = 'php vendor/bin/phpunit {path}';
      cmds.suite = 'php vendor/bin/phpunit';
    }
  } else if ((profile.id === 'laravel' || profile.id === 'symfony') && 'pestphp/pest' in m.composerDeps) {
    cmds.file = 'php vendor/bin/pest {path}';
    cmds.suite = 'php vendor/bin/pest';
  } else if (profile.id === 'node') {
    const scripts = m.pkgData.scripts ?? {};
    const pm = existsSync(resolve(root, appDir, 'pnpm-lock.yaml')) ? 'pnpm'
      : existsSync(resolve(root, appDir, 'yarn.lock')) ? 'yarn' : 'npm';
    cmds.suite = scripts.test ? `${pm} test` : null;
    if ('vitest' in m.npmDeps) cmds.file = 'npx vitest run {path}';
    else if ('jest' in m.npmDeps) cmds.file = 'npx jest {path}';
    else if ((scripts.test ?? '').includes('node --test')) cmds.file = 'node --test {path}';
    else cmds.file = scripts.test ? `${pm} test -- {path}` : null;
    if (!scripts.test && !cmds.file) cmds.lint = null;
  } else if (profile.id === 'python') {
    const hasPytest = m.pyText.includes('pytest');
    if (!hasPytest && findFile('manage.py')) {
      cmds.file = 'python manage.py test {path}';
      cmds.suite = 'python manage.py test';
    } else if (!hasPytest) {
      cmds.file = 'python -m unittest {path}';
      cmds.suite = 'python -m unittest discover';
    }
  }
  return cmds;
}

export function detect() {
  const profiles = loadProfiles();
  const m = manifests();
  const pick = pickProfile(profiles, m);
  const profile = profiles.find((p) => p.id === pick.profile) ?? profiles.find((p) => p.id === 'generic');
  const manifestDir = profile.runtime === 'php' ? m.composer?.dir
    : profile.runtime === 'node' ? m.pkg?.dir
    : profile.runtime === 'python' ? m.pyFiles[0]?.dir : null;
  const appDir = manifestDir ?? '.';
  const instr = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'].filter((f) => existsSync(resolve(root, f)));
  const skillNames = [];
  for (const base of ['.agents/skills', '.claude/skills']) {
    const dir = resolve(root, base);
    if (existsSync(dir)) skillNames.push(...readdirSync(dir));
  }
  const testSkill = [...new Set(skillNames)].find((n) => /test/i.test(n) && !n.startsWith('deliver')) ?? null;
  const appPrefix = appDir === '.' ? '' : `${appDir}/`;
  const codeDirs = existingDirs([...profile.code_dir_hints.map((d) => d)]);
  const testDirs = [...new Set(existingDirs(['tests', 'test', 'spec', '__tests__', `${appPrefix}tests`, `${appPrefix}test`]))];
  const pyproject = m.pyFiles.find((f) => f.path.endsWith('pyproject.toml'));
  const pyName = pyproject ? (rd(pyproject.path) ?? '').match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1] : null;
  return {
    profile: pick.profile,
    profileLabel: profile.label,
    evidence: pick.evidence,
    alternatives: pick.alternatives,
    appDir,
    projectName: m.pkgData.name ?? m.composerData.name ?? pyName ?? basename(root),
    git: gitInfo(),
    docker: dockerInfo(profile),
    instructions: instr,
    testSkill,
    codeDirs,
    testDirs,
    testCommands: refineTestCommands(profile, m, appDir),
    empty: !m.composer && !m.pkg && m.pyFiles.length === 0 && codeDirs.length === 0,
  };
}

/** Draft project.json. Anything that could not be determined is listed in `unresolved`. */
export function buildDraft(d) {
  const profile = loadProfiles().find((p) => p.id === d.profile);
  const unresolved = [];
  const ask = (key, question, def) => unresolved.push({ key, question, default: def ?? null });

  const useDocker = !!(d.docker.compose && d.docker.suggested);
  const test = {
    env: useDocker ? 'docker' : 'local',
    service: useDocker ? d.docker.suggested : null,
    exec_prefix: useDocker ? `docker compose exec -T ${d.docker.suggested}` : null,
    workdir: d.appDir === '.' ? null : d.appDir,
    suites: profile.test.suites,
    commands: d.testCommands,
    rules: profile.test.rules,
    skill: d.testSkill,
  };
  if (useDocker) {
    ask('test.env', `Tests run in Docker service "${d.docker.suggested}" (docker compose exec). Correct?`, 'yes');
  }
  if (!test.commands.file && !test.skill) {
    ask('test.commands.file', 'Which command runs a single test file? (use {path} for the file)', null);
    ask('test.commands.suite', 'Which command runs the whole test suite?', null);
  }
  if (d.profile === 'generic') ask('profile', 'Stack was not recognised. Which language and framework is this project?', null);
  if (!d.instructions.length) ask('instructions_file', 'No AGENTS.md or CLAUDE.md found. Create AGENTS.md with a short project map?', 'yes');
  ask('language', 'Language for questions and reports?', 'en');
  if (d.git.host) ask('publish', `Push the branch and open a draft merge request on ${d.git.host} when done?`, 'no');
  if (!d.git.isRepo) ask('git', 'This folder is not a git repository. Run git init?', 'yes');

  const testDirs = d.testDirs.length ? d.testDirs : [`${d.appDir === '.' ? '' : d.appDir + '/'}tests/`];
  return {
    module_version: MODULE_VERSION,
    configured: false,
    profile: d.profile,
    project: d.projectName,
    language: null,
    instructions_file: d.instructions.includes('AGENTS.md') ? 'AGENTS.md' : d.instructions[0] ?? null,
    base_branch: d.git.baseBranch ?? 'main',
    branch_prefix: 'ai/',
    isolation: 'branch',
    task_dir: '.work/tasks',
    app_dir: d.appDir,
    code_dirs: d.codeDirs.length ? d.codeDirs : ['src/'],
    test_dirs: testDirs,
    test,
    domain_skills: {},
    forbidden_paths: profile.forbidden_paths,
    architect_triggers: profile.architect_triggers,
    human_approval: HUMAN_APPROVAL,
    review_checklist: profile.review_checklist,
    roles: { ...DEFAULT_ROLES },
    commands: { ...DEFAULT_COMMANDS },
    limits: { ...DEFAULT_LIMITS },
    publish: false,
    roles_confirmed: false,
    permissions_confirmed: false,
    unresolved,
  };
}
