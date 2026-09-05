import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('CLI compares revision metadata with staged and unstaged files without changing git state', () => {
  const root = mkdtempSync(join(tmpdir(), 'complexity-delta-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  try {
    git('init', '--quiet');
    const files = {
      'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@leaf":["./leaf.ts"]}}}',
      'leaf.ts': 'export function leaf() { return 1; }',
      'other.ts': 'export function leaf() { return 2; }',
      'entry.ts': "import { leaf } from '@leaf'; export function run() { return leaf(); }",
    };
    for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--quiet',
      '-m',
      'base',
    );
    writeFileSync(
      join(root, 'tsconfig.json'),
      files['tsconfig.json'].replace('./leaf.ts', './other.ts'),
    );
    git('add', 'tsconfig.json');
    writeFileSync(
      join(root, 'entry.ts'),
      "import { leaf } from '@leaf'; function wrapper() { const result = leaf(); return result; } export function run() { return wrapper(); }",
    );
    writeFileSync(join(root, 'untracked.ts'), 'export const extra = () => 3;');
    const status = git('status', '--porcelain=v1');
    const index = git('diff', '--cached');
    const working = git('diff');
    const report = JSON.parse(
      execFileSync(
        process.execPath,
        [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'HEAD', '--json'],
        { cwd: root, encoding: 'utf8' },
      ),
    );
    assert.equal(report.before.callEdges, 1);
    assert.equal(report.delta.callEdges, 1);
    assert.equal(report.delta.functions, 2);
    assert.equal(report.delta.sourceFiles, 1);
    assert.deepEqual(
      report.newIntermediateConcepts.map((item: { name: string }) => item.name),
      ['wrapper'],
    );
    assert.equal(git('status', '--porcelain=v1'), status);
    assert.equal(git('diff', '--cached'), index);
    assert.equal(git('diff'), working);
    assert.equal(readFileSync(join(root, 'untracked.ts'), 'utf8'), 'export const extra = () => 3;');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
