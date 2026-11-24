// Syntax-check every first-party JavaScript/MJS file without adding a lint
// dependency. `node --check` understands the project's ESM package setting.
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const roots = ['server.js', 'src', 'web', 'scripts', 'test'];
const files = [];

function visit(path) {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (entry === 'node_modules' || entry.startsWith('.git')) continue;
      visit(join(path, entry));
    }
  } else if (/\.(?:js|mjs|cjs)$/u.test(path)) {
    files.push(path);
  }
}

for (const path of roots) visit(join(root, path));

let failed = 0;
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    failed += 1;
    console.error(`Syntax check failed: ${relative(root, file)}`);
    if (result.stdout) console.error(result.stdout);
    if (result.stderr) console.error(result.stderr);
  }
}

if (failed) {
  console.error(`\n${failed}/${files.length} file(s) failed syntax checks.`);
  process.exit(1);
}
console.log(`Syntax OK: ${files.length} JavaScript file(s).`);
