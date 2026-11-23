#!/usr/bin/env node
// Stand-in for the GitHub CLI. State lives in $FAKE_GH_DIR.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.FAKE_GH_DIR;
const a = process.argv.slice(2);
const flag = (n) => a[a.indexOf(n) + 1];
const prFile = join(dir, 'pr.json');
appendFileSync(join(dir, 'calls.log'), a.slice(0, 2).join(' ') + '\n');
const URL = 'https://github.com/acme/sample/pull/7';

if (a[0] === 'pr' && a[1] === 'view') {
  if (!existsSync(prFile)) { process.stderr.write('no pull requests found'); process.exit(1); }
  process.stdout.write(JSON.stringify({ url: URL, state: 'OPEN' }));
} else if (a[0] === 'pr' && a[1] === 'create') {
  writeFileSync(prFile, JSON.stringify({ url: URL, title: flag('--title'), body: flag('--body'), base: flag('--base'), head: flag('--head') }));
  process.stdout.write(`Creating pull request...\n${URL}\n`);
} else if (a[0] === 'pr' && a[1] === 'edit') {
  const pr = JSON.parse(readFileSync(prFile, 'utf8'));
  writeFileSync(prFile, JSON.stringify({ ...pr, body: flag('--body'), edited: (pr.edited ?? 0) + 1 }));
} else if (a[0] === 'pr' && a[1] === 'checks') {
  const qf = join(dir, 'checks.json');
  const q = JSON.parse(readFileSync(qf, 'utf8'));
  const cur = q.length > 1 ? q.shift() : q[0];
  writeFileSync(qf, JSON.stringify(q));
  if (cur === 'none') { process.stderr.write("no checks reported on the 'x' branch"); process.exit(1); }
  const checks = { pending: [{ name: 'test', bucket: 'pending', workflow: 'CI' }], pass: [{ name: 'test', bucket: 'pass', workflow: 'CI' }],
    fail: [{ name: 'test', bucket: 'fail', workflow: 'CI', link: 'https://github.com/acme/sample/actions/runs/4242/job/1' }] }[cur];
  process.stdout.write(JSON.stringify(checks));
  process.exit(cur === 'pending' ? 8 : cur === 'fail' ? 1 : 0);
} else if (a[0] === 'run' && a[1] === 'view') {
  process.stdout.write(`test\tRun tests\tnot ok 1 - multiply on CI runner (run ${a[2]})\n  expected: 6\n  actual: NaN\n`);
} else {
  process.stderr.write('unsupported: ' + a.join(' ')); process.exit(1);
}
