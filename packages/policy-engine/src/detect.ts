import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Onboarding for an arbitrary repository: work out how the project is built and
 * tested from its own files, so a project without devpilot.yaml still gets real
 * gates instead of NOT_VERIFIED everywhere.
 *
 * The result is a policy layer: defaults <- detected <- the project's devpilot.yaml.
 * Every gate the project has no tooling for is switched off *with a note*, so the
 * report says "no linter in this project" instead of pretending it passed.
 */
export interface DetectedProfile {
  stack: string[];
  commands: Record<string, string>;
  quality: Record<string, unknown>;
  /** gate -> why it is switched off / unverifiable (shown as the gate reason). */
  notes: Record<string, string>;
  /** command -> which project file it was derived from. */
  sources: Record<string, string>;
  /** Untracked paths created by setup/tests that must never be committed. */
  ignore: string[];
  /** Delivery overrides (a repo without a remote is delivered as a local branch). */
  delivery?: Record<string, unknown>;
}

type Cmd = 'setup' | 'typecheck' | 'lint' | 'build' | 'unit_tests' | 'integration_tests' | 'e2e_tests' | 'security_scan';

const NPM_DEFAULT_TEST = /no test specified/;
const MANIFESTS = ['**/package.json', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/bun.lock', '**/bun.lockb'];

function readJson(p: string): any {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return undefined;
  }
}
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

export function detectProject(repo: string): DetectedProfile {
  const has = (...f: string[]) => f.some((x) => existsSync(join(repo, x)));
  const cmd: Partial<Record<Cmd, string>> = {};
  const notes: Record<string, string> = {};
  const sources: Record<string, string> = {};
  const stack: string[] = [];
  const ignore = new Set<string>();
  const quality: Record<string, unknown> = {};
  const set = (k: Cmd, v: string | undefined, why: string) => {
    if (v && !cmd[k]) {
      cmd[k] = v;
      sources[k] = why;
    }
  };

  // --- Node / TypeScript ---------------------------------------------------------
  const pkg = readJson(join(repo, 'package.json'));
  if (pkg) {
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lock', 'bun.lockb') ? 'bun' : 'npm';
    stack.push(has('tsconfig.json') ? `node-ts (${pm})` : `node (${pm})`);
    const run = (s: string) => ({ npm: `npm run ${s}`, pnpm: `pnpm run ${s}`, yarn: `yarn ${s}`, bun: `bun run ${s}` })[pm];
    const exec = { npm: 'npx --no-install', pnpm: 'pnpm exec', yarn: 'yarn', bun: 'bunx' }[pm];
    const scripts: Record<string, string> = pkg.scripts ?? {};
    const script = (...names: string[]) => names.find((n) => scripts[n] && !NPM_DEFAULT_TEST.test(scripts[n]!));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const berry = has('.yarnrc.yml');
    set(
      'setup',
      {
        npm: has('package-lock.json') ? 'npm ci --no-audit --no-fund' : 'npm install --no-audit --no-fund',
        pnpm: 'pnpm install --frozen-lockfile',
        yarn: berry ? 'yarn install --immutable' : 'yarn install --frozen-lockfile',
        bun: 'bun install --frozen-lockfile',
      }[pm],
      `${pm} lockfile`,
    );
    ignore.add('node_modules/');
    let s = script('typecheck', 'type-check', 'check-types', 'types', 'tsc');
    if (s) set('typecheck', run(s), `package.json script "${s}"`);
    else if (has('tsconfig.json') && deps.typescript) set('typecheck', `${exec} tsc --noEmit`, 'tsconfig.json + typescript dependency');
    s = script('lint');
    if (s) set('lint', run(s), 'package.json script "lint"');
    else if (has('biome.json', 'biome.jsonc') && deps['@biomejs/biome']) set('lint', `${exec} biome check .`, 'biome config');
    else if (deps.eslint && readdirSync(repo).some((f) => /^(\.eslintrc(\..+)?|eslint\.config\.\w+)$/.test(f))) set('lint', `${exec} eslint .`, 'eslint config');
    s = script('test:unit', 'unit', 'test');
    if (s) set('unit_tests', run(s), `package.json script "${s}"`);
    s = script('test:integration', 'test:int', 'integration');
    if (s) set('integration_tests', run(s), `package.json script "${s}"`);
    s = script('test:e2e', 'e2e', 'test:playwright', 'playwright', 'cypress');
    if (s) set('e2e_tests', run(s), `package.json script "${s}"`);
    s = script('build');
    if (s) set('build', run(s), 'package.json script "build"');
    set('security_scan', { npm: 'npm audit --audit-level=high', pnpm: 'pnpm audit --audit-level high', yarn: berry ? 'yarn npm audit --severity high' : 'yarn audit --level high', bun: 'bun audit' }[pm], `${pm} audit`);
    // Advisories unrelated to the change would fail every task: audit only when dependencies change.
    quality.security_scan = { mode: 'conditional', when: { paths: MANIFESTS } };
    if (!cmd.unit_tests) {
      set('unit_tests', 'node --test', 'no test script: Node built-in test runner (*.test.js / *.test.ts)');
    }
  }

  // --- Python ------------------------------------------------------------------------
  if (has('pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile')) {
    const pyproject = read(join(repo, 'pyproject.toml'));
    const reqs = ['requirements.txt', 'requirements-dev.txt', 'requirements_dev.txt', 'dev-requirements.txt'].filter((f) => has(f));
    const alltext = pyproject + reqs.map((f) => read(join(repo, f))).join('\n') + read(join(repo, 'setup.cfg'));
    let py: string;
    if (has('uv.lock')) {
      stack.push('python (uv)');
      set('setup', 'uv sync --all-extras --frozen', 'uv.lock');
      py = 'uv run python';
    } else if (has('poetry.lock')) {
      stack.push('python (poetry)');
      set('setup', 'poetry install --no-interaction', 'poetry.lock');
      py = 'poetry run python';
    } else {
      // A per-worktree virtualenv: never install into the host interpreter.
      stack.push('python (venv)');
      const installs = [
        ...reqs.map((f) => `.venv/bin/pip install -q -r ${f}`),
        ...(pyproject || has('setup.py') ? ['.venv/bin/pip install -q -e .'] : []),
      ];
      set('setup', ['python3 -m venv .venv', ...installs].join(' && '), 'python project: per-worktree .venv');
      py = '.venv/bin/python';
      if (!/pytest/.test(alltext)) cmd.setup += ' && .venv/bin/pip install -q pytest';
    }
    ignore.add('.venv/').add('__pycache__/').add('.pytest_cache/').add('*.egg-info/').add('.mypy_cache/').add('.ruff_cache/');
    const usesPytest = /pytest/.test(alltext) || has('pytest.ini', 'conftest.py', 'tests/conftest.py', 'tox.ini');
    set('unit_tests', usesPytest || !has('uv.lock', 'poetry.lock') ? `${py} -m pytest -q` : `${py} -m unittest discover -q`, usesPytest ? 'pytest' : 'python tests');
    if (/\[tool\.ruff/.test(pyproject) || has('ruff.toml', '.ruff.toml') || /\bruff\b/.test(alltext)) set('lint', `${py} -m ruff check .`, 'ruff config');
    else if (has('.flake8') || /\[flake8\]/.test(read(join(repo, 'setup.cfg')) + read(join(repo, 'tox.ini')))) set('lint', `${py} -m flake8`, 'flake8 config');
    if (/\[tool\.mypy/.test(pyproject) || has('mypy.ini', '.mypy.ini')) set('typecheck', `${py} -m mypy .`, 'mypy config');
    else if (has('pyrightconfig.json') || /\[tool\.pyright/.test(pyproject)) set('typecheck', `${py} -m pyright`, 'pyright config');
    else set('typecheck', `${py} -m compileall -q -x '(^|/)(\\.venv|node_modules)/' .`, 'no type checker: byte-compile every module (syntax/import-level check)');
  }

  // --- Go ---------------------------------------------------------------------------
  if (has('go.mod')) {
    stack.push('go');
    set('setup', 'go mod download', 'go.mod');
    set('typecheck', 'go vet ./...', 'go vet');
    set('unit_tests', 'go test ./...', 'go test');
    set('build', 'go build ./...', 'go build');
    if (has('.golangci.yml', '.golangci.yaml', '.golangci.toml', '.golangci.json')) set('lint', 'golangci-lint run', 'golangci-lint config');
    else set('lint', 'test -z "$(gofmt -l .)"', 'gofmt (no linter config)');
  }

  // --- Rust ---------------------------------------------------------------------------
  if (has('Cargo.toml')) {
    stack.push('rust');
    set('typecheck', 'cargo check --all-targets', 'cargo check');
    set('lint', 'cargo clippy --all-targets', 'cargo clippy');
    set('unit_tests', 'cargo test', 'cargo test');
    set('build', 'cargo build', 'cargo build');
    ignore.add('target/');
  }

  // --- JVM -----------------------------------------------------------------------------
  if (has('gradlew')) {
    stack.push('jvm (gradle)');
    set('typecheck', './gradlew --no-daemon -q compileJava compileTestJava', 'gradle wrapper');
    set('unit_tests', './gradlew --no-daemon test', 'gradle test');
    ignore.add('build/').add('.gradle/');
  } else if (has('pom.xml')) {
    stack.push('jvm (maven)');
    set('typecheck', 'mvn -q -B test-compile', 'maven');
    set('unit_tests', 'mvn -q -B test', 'maven test');
    ignore.add('target/');
  }

  // --- Makefile as the project's own contract (fills gaps only) ---------------------
  const mk = read(join(repo, 'Makefile'));
  if (mk) {
    const target = (t: string) => new RegExp(`^${t}\\s*:`, 'm').test(mk);
    if (target('test')) set('unit_tests', 'make test', 'Makefile target "test"');
    if (target('lint')) set('lint', 'make lint', 'Makefile target "lint"');
    if (target('typecheck')) set('typecheck', 'make typecheck', 'Makefile target "typecheck"');
    if (!stack.length) stack.push('make');
  }

  // Gates the project has no tooling for: off, and the report says why.
  for (const g of ['typecheck', 'lint', 'integration_tests', 'e2e_tests', 'security_scan'] as const) {
    if (cmd[g] || quality[g]) continue;
    quality[g] = 'off';
    notes[g] = `project has no ${g.replace('_', ' ')} tooling (auto-detected)`;
  }
  if (!cmd.unit_tests) notes.unit_tests = 'no test runner detected: set commands.unit_tests in devpilot.yaml';
  // Nowhere to push: deliver the verified branch locally instead of failing at the PR step.
  const gitcfg = read(join(repo, '.git', 'config'));
  let delivery: Record<string, unknown> | undefined;
  if (existsSync(join(repo, '.git')) && !/^\[remote "/m.test(gitcfg)) {
    delivery = { push: false, create_pr: false, require_ci: false };
    notes.delivery = 'repository has no git remote: delivered as a local branch (no push / PR / CI)';
  }
  return { stack, commands: cmd as Record<string, string>, quality, notes, sources, ignore: [...ignore], delivery };
}

/** The policy layer written for the detected profile (consumed by loadPolicy). */
export function profileToPolicy(p: DetectedProfile): Record<string, unknown> {
  return {
    commands: p.commands,
    quality: p.quality,
    notes: p.notes,
    ...(p.delivery ? { delivery: p.delivery } : {}),
    detected: { stack: p.stack, ignore: p.ignore, sources: p.sources },
  };
}
