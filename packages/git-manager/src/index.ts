import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { DevPilotError } from '@devpilot/shared';

const pexec = promisify(execFile);

/** DevPilot's commit identity, passed per command: `git config` in a worktree writes the repo's shared
 *  .git/config and would re-author every human commit in the repository. */
const IDENTITY = ['-c', 'user.name=DevPilot', '-c', 'user.email=devpilot@localhost'];

export async function git(cwd: string, args: string[], opts: { allowFail?: boolean } = {}): Promise<string> {
  try {
    const { stdout } = await pexec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return stdout.trimEnd();
  } catch (e: any) {
    if (opts.allowFail) return '';
    throw new DevPilotError(`git ${args.join(' ')} failed: ${e.stderr || e.message}`, 'GIT_ERROR');
  }
}

export interface Worktree {
  path: string;
  branch: string;
  baseCommit: string;
}

export class GitManager {
  constructor(
    readonly repoPath: string,
    readonly worktreesRoot: string,
  ) {}

  async resolve(ref: string) {
    return git(this.repoPath, ['rev-parse', ref]);
  }

  /**
   * Keep setup/test byproducts (.venv, node_modules, caches) out of DevPilot's commits
   * without touching the repo's tracked .gitignore: a marked block in the shared
   * info/exclude, which every worktree honours. Only affects untracked files.
   */
  async ensureExcludes(patterns: string[]) {
    if (!patterns.length) return;
    let common = await git(this.repoPath, ['rev-parse', '--git-common-dir']);
    if (!isAbsolute(common)) common = join(this.repoPath, common);
    const file = join(common, 'info', 'exclude');
    const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const begin = '# >>> devpilot (generated, safe to delete)';
    const end = '# <<< devpilot';
    const block = `${begin}\n${patterns.join('\n')}\n${end}\n`;
    const re = new RegExp(`${begin.replace(/[()]/g, '\\$&')}[\\s\\S]*?${end}\\n?`);
    const next = re.test(cur) ? cur.replace(re, block) : `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${block}`;
    if (next === cur) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, next);
  }

  /** Idempotent: re-attaches to an existing worktree after a crash. */
  async ensureWorktree(taskId: string, baseRef: string): Promise<Worktree> {
    const branch = `devpilot/${taskId.toLowerCase()}`;
    const path = `${this.worktreesRoot}/${taskId}`;
    if (existsSync(path)) {
      const base = await git(path, ['merge-base', 'HEAD', baseRef], { allowFail: true });
      return { path, branch, baseCommit: base || (await this.resolve(baseRef)) };
    }
    mkdirSync(dirname(path), { recursive: true });
    const baseCommit = await this.resolve(baseRef);
    const branchExists = (await git(this.repoPath, ['branch', '--list', branch])) !== '';
    await git(this.repoPath, branchExists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, baseCommit]);
    return { path, branch, baseCommit };
  }

  async removeWorktree(path: string) {
    await git(this.repoPath, ['worktree', 'remove', '--force', path], { allowFail: true });
  }
}

export async function head(worktree: string) {
  return git(worktree, ['rev-parse', 'HEAD']);
}

/** Snapshot whatever the agent left in the working tree. Returns new HEAD. */
export async function commitAll(worktree: string, message: string): Promise<{ head: string; committed: boolean }> {
  await git(worktree, ['add', '-A']);
  const staged = await git(worktree, ['diff', '--cached', '--name-only']);
  if (!staged) return { head: await head(worktree), committed: false };
  await git(worktree, [...IDENTITY, 'commit', '-q', '--no-verify', '-m', message]);
  return { head: await head(worktree), committed: true };
}

export async function isClean(worktree: string) {
  return (await git(worktree, ['status', '--porcelain'])) === '';
}

export interface FileChange {
  status: 'A' | 'M' | 'D' | 'R' | string;
  path: string;
}

export async function changedFiles(worktree: string, base: string): Promise<FileChange[]> {
  const out = await git(worktree, ['diff', '--name-status', '--no-renames', `${base}..HEAD`]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [status, ...rest] = l.split('\t');
      return { status: status ?? '?', path: rest.join('\t') };
    });
}

export async function diff(worktree: string, base: string, paths: string[] = []) {
  return git(worktree, ['diff', '--unified=3', `${base}..HEAD`, '--', ...paths]);
}

export async function addedLines(worktree: string, base: string): Promise<{ file: string; line: string }[]> {
  const out = await git(worktree, ['diff', '--unified=0', '--no-color', `${base}..HEAD`]);
  const res: { file: string; line: string }[] = [];
  let file = '';
  for (const l of out.split('\n')) {
    if (l.startsWith('+++ ')) file = l.slice(6);
    else if (l.startsWith('+') && !l.startsWith('+++')) res.push({ file, line: l.slice(1) });
  }
  return res;
}

export async function hasRemote(repo: string, remote: string) {
  return (await git(repo, ['remote'], { allowFail: true })).split('\n').includes(remote);
}

export async function push(worktree: string, remote: string, branch: string) {
  await git(worktree, ['push', '-u', remote, `HEAD:refs/heads/${branch}`]);
}

// --- GitHub (gh CLI). DevPilot opens PRs and reads CI; it never merges. -------------
const ghBin = () => process.env.DEVPILOT_GH_BIN ?? 'gh';

async function gh(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await pexec(ghBin(), args, { cwd, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } });
    return { stdout, stderr, code: 0 };
  } catch (e: any) {
    if (e.code === 'ENOENT') throw new DevPilotError('GitHub CLI (gh) not found', 'PR_ERROR');
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? e.message, code: typeof e.code === 'number' ? e.code : 1 };
  }
}

/** Idempotent: returns the existing open PR for the branch if there is one. */
export async function findPullRequest(cwd: string, branch: string): Promise<string | undefined> {
  const r = await gh(cwd, ['pr', 'view', branch, '--json', 'url,state']);
  if (r.code !== 0) return undefined;
  const v = JSON.parse(r.stdout) as { url: string; state: string };
  return v.state === 'OPEN' ? v.url : undefined;
}

export async function createPullRequest(o: { cwd: string; base: string; branch: string; title: string; body: string; draft: boolean }) {
  const args = ['pr', 'create', '--base', o.base, '--head', o.branch, '--title', o.title, '--body', o.body];
  if (o.draft) args.push('--draft');
  const r = await gh(o.cwd, args);
  if (r.code !== 0) throw new DevPilotError(`gh pr create failed: ${r.stderr.trim()}`, 'PR_ERROR');
  return r.stdout.trim().split('\n').pop() ?? '';
}

export async function updatePullRequestBody(cwd: string, pr: string, body: string) {
  const r = await gh(cwd, ['pr', 'edit', pr, '--body', body]);
  if (r.code !== 0) throw new DevPilotError(`gh pr edit failed: ${r.stderr.trim()}`, 'PR_ERROR');
}

export interface CiCheck {
  name: string;
  bucket: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel' | string;
  link?: string;
  workflow?: string;
}
export interface CiStatus {
  /** none: no checks reported (yet). */
  state: 'none' | 'pending' | 'pass' | 'fail';
  checks: CiCheck[];
}

export async function prChecks(cwd: string, pr: string): Promise<CiStatus> {
  // Exit codes: 0 all passed, 8 pending, 1 failed checks OR a real error — so trust the JSON, not the code.
  const r = await gh(cwd, ['pr', 'checks', pr, '--json', 'name,bucket,link,workflow']);
  let parsed: CiCheck[] | undefined;
  try {
    const v = JSON.parse(r.stdout);
    if (Array.isArray(v)) parsed = v as CiCheck[];
  } catch {
    /* not JSON */
  }
  if (!parsed) {
    if (/no checks reported/i.test(r.stderr + r.stdout)) return { state: 'none', checks: [] };
    throw new DevPilotError(`gh pr checks failed (exit ${r.code}): ${r.stderr.trim()}`, 'CI_ERROR');
  }
  const checks = parsed.filter((c) => c.bucket !== 'skipping');
  if (checks.length === 0) return { state: 'none', checks };
  if (checks.some((c) => c.bucket === 'fail' || c.bucket === 'cancel')) return { state: 'fail', checks };
  if (checks.some((c) => c.bucket === 'pending')) return { state: 'pending', checks };
  return { state: 'pass', checks };
}

/** Tail of the failed-step logs of a GitHub Actions run, for the fixer. */
export async function failedCheckLog(cwd: string, link?: string): Promise<string> {
  const runId = link?.match(/\/actions\/runs\/(\d+)/)?.[1];
  if (!runId) return '(no Actions log available for this check)';
  const r = await gh(cwd, ['run', 'view', runId, '--log-failed']);
  const out = r.code === 0 ? r.stdout : r.stderr;
  return out.length > 12000 ? '…' + out.slice(-12000) : out;
}

// --- integration of parallel branches -------------------------------------------
export interface MergeResult {
  ok: boolean;
  head: string;
  conflicts: string[];
}

/** Merge `branch` into the worktree's branch. On conflict the merge is left in progress. */
export async function mergeBranch(worktree: string, branch: string, message: string): Promise<MergeResult> {
  try {
    await pexec('git', [...IDENTITY, 'merge', '--no-ff', '-m', message, branch], { cwd: worktree, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return { ok: true, head: await head(worktree), conflicts: [] };
  } catch {
    const conflicts = (await git(worktree, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
    if (!conflicts.length) throw new DevPilotError(`git merge ${branch} failed without conflicts`, 'GIT_ERROR');
    return { ok: false, head: await head(worktree), conflicts };
  }
}

/** Files that still contain conflict markers. */
export async function filesWithConflictMarkers(worktree: string, files: string[]): Promise<string[]> {
  const out: string[] = [];
  const { readFile } = await import('node:fs/promises');
  for (const f of files) {
    try {
      if (/^(<{7}|={7}|>{7})( |$)/m.test(await readFile(`${worktree}/${f}`, 'utf8'))) out.push(f);
    } catch {
      /* deleted in resolution */
    }
  }
  return out;
}

export async function concludeMerge(worktree: string): Promise<string> {
  await git(worktree, ['add', '-A']);
  await git(worktree, [...IDENTITY, 'commit', '-q', '--no-verify', '--no-edit']);
  return head(worktree);
}

export async function abortMerge(worktree: string) {
  await git(worktree, ['merge', '--abort'], { allowFail: true });
}
