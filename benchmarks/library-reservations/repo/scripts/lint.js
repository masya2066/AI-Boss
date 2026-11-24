// Project lint rules: no console.log / debugger in src, no TODO without an owner.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
const bad = [];
const walk = (d) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith('.js') && check(join(d, f))));
const check = (f) =>
  readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
    if (/console\.log|debugger/.test(l)) bad.push(`${f}:${i + 1}: no console.log/debugger in src`);
    if (/TODO(?!\(\w+\))/.test(l)) bad.push(`${f}:${i + 1}: TODO needs an owner: TODO(name)`);
  });
walk('src');
if (bad.length) {
  process.stderr.write(bad.join('\n') + '\n');
  process.exit(1);
}
