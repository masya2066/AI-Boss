import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** The executor itself failed (binary missing, docker down) - not the command. */
  infraError?: string;
}

export interface ExecOptions {
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
  logPath?: string;
}

/** Where gate commands run. Agents never get a handle to this. */
export interface Executor {
  readonly kind: string;
  run(command: string, opts: ExecOptions): Promise<ExecResult>;
}

const BASE_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR', 'SHELL', 'USER'];

/** Minimal environment: secrets from the orchestrator's env never leak into commands. */
export function scrubbedEnv(passthrough: string[] = [], extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { CI: '1', DEVPILOT: '1' };
  for (const k of [...BASE_ENV_KEYS, ...passthrough]) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return { ...env, ...extra };
}

function runProcess(bin: string, args: string[], opts: ExecOptions & { env: Record<string, string> }): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolveP) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const cap = (s: string, chunk: Buffer) => (s.length > 2_000_000 ? s : s + chunk.toString());
    child.stdout.on('data', (c: Buffer) => (stdout = cap(stdout, c)));
    child.stderr.on('data', (c: Buffer) => (stderr = cap(stderr, c)));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL'); // kill the whole process group
      } catch {
        child.kill('SIGKILL');
      }
    }, opts.timeoutMs);
    const finish = (r: ExecResult) => {
      clearTimeout(timer);
      if (opts.logPath) {
        mkdirSync(dirname(opts.logPath), { recursive: true });
        writeFileSync(opts.logPath, `$ ${args.join(' ')}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}\n--- exit ${r.exitCode}${r.timedOut ? ' (timeout)' : ''} ---\n`);
      }
      resolveP(r);
    };
    child.on('error', (err) => finish({ exitCode: null, stdout, stderr, durationMs: Date.now() - started, timedOut, infraError: err.message }));
    child.on('close', (code) => finish({ exitCode: code, stdout, stderr, durationMs: Date.now() - started, timedOut }));
  });
}

export class LocalExecutor implements Executor {
  readonly kind = 'local';
  constructor(private readonly passthrough: string[] = []) {}
  run(command: string, opts: ExecOptions) {
    return runProcess('/bin/sh', ['-c', command], { ...opts, env: opts.env ?? scrubbedEnv(this.passthrough) });
  }
}

export interface DockerExecutorOptions {
  image: string;
  network: 'none' | 'bridge';
  cpus: string;
  memory: string;
  passthrough?: string[];
}

/**
 * Throwaway container per command: only the worktree is mounted, no docker
 * socket, no host credentials, dropped capabilities, configurable network.
 */
export class DockerExecutor implements Executor {
  readonly kind = 'docker';
  constructor(private readonly o: DockerExecutorOptions) {}
  run(command: string, opts: ExecOptions) {
    const envArgs = Object.entries(scrubbedEnv(this.o.passthrough ?? [], opts.env ?? {}))
      .filter(([k]) => !['PATH', 'HOME', 'TMPDIR', 'SHELL', 'USER'].includes(k))
      .flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    const args = [
      'run', '--rm', '--init',
      '--network', this.o.network,
      '--cpus', this.o.cpus,
      '--memory', this.o.memory,
      '--pids-limit', '1024',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      // Run as the host user so files written into the worktree are not root-owned.
      ...(typeof process.getuid === 'function' ? ['--user', `${process.getuid()}:${process.getgid!()}`] : []),
      '-e', 'HOME=/tmp',
      '-v', `${opts.cwd}:/workspace`,
      '-w', '/workspace',
      ...envArgs,
      this.o.image,
      'sh', '-c', command,
    ];
    return runProcess('docker', args, { ...opts, env: scrubbedEnv() });
  }
}
