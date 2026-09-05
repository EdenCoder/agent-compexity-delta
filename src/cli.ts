#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { affectedFiles, analyze, compare, render, type Snapshot } from './index.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const positional = args.filter((arg) => arg !== '--json');
if (positional.length > 1 || args.includes('--help')) {
  console.log('Usage: complexity-delta [base-revision] [--json]');
  process.exit(positional.length > 1 ? 1 : 0);
}

const base = positional[0] ?? 'HEAD';
const root = git(['rev-parse', '--show-toplevel']).toString().trim();
process.chdir(root);

try {
  const before = readRevision(base);
  const after = readWorkingTree();
  const changed = changedFiles(base);
  const files =
    changed && new Set([...affectedFiles(before, changed), ...affectedFiles(after, changed)]);
  const result = compare(analyze(before, files), analyze(after, files));
  console.log(json ? JSON.stringify(result, null, 2) : render(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

function readRevision(revision: string): Snapshot {
  const entries = git(['ls-tree', '-r', '-z', revision, '--'])
    .toString()
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const match = entry.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/s);
      return match && isSnapshotFile(match[2]!) ? { hash: match[1]!, path: match[2]! } : null;
    })
    .filter((entry): entry is { hash: string; path: string } => !!entry);
  if (!entries.length) return { files: {} };

  const blobs = git(
    ['cat-file', '--batch'],
    Buffer.from(entries.map(({ hash }) => hash).join('\n') + '\n'),
  );
  const files: Record<string, string> = {};
  let offset = 0;
  for (const entry of entries) {
    const newline = blobs.indexOf(10, offset);
    const header = blobs.subarray(offset, newline).toString();
    const size = Number(header.split(' ')[2]);
    const start = newline + 1;
    files[entry.path] = blobs.subarray(start, start + size).toString();
    offset = start + size + 1;
  }
  return { files };
}

// A changed tsconfig, package manifest or declaration file can re-point
// resolution for any file, so those changes measure the whole repository.
function changedFiles(revision: string): Set<string> | undefined {
  const paths = [
    ...git(['diff', '--name-only', '-z', revision, '--']).toString().split('\0'),
    ...git(['ls-files', '--others', '--exclude-standard', '-z']).toString().split('\0'),
  ].filter((path) => path && isSnapshotFile(path));
  const global = /(^|\/)(?:tsconfig[^/]*|package)\.json$|\.d\.[cm]?ts$/;
  return paths.some((path) => global.test(path)) ? undefined : new Set(paths);
}

function readWorkingTree(): Snapshot {
  const paths = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    .toString()
    .split('\0')
    .filter((path) => path && isSnapshotFile(path) && existsSync(path));
  return {
    files: Object.fromEntries(paths.map((path) => [path, readFileSync(path, 'utf8')])),
  };
}

function git(args: string[], input?: Buffer): Buffer {
  try {
    return execFileSync('git', args, {
      cwd: process.cwd(),
      input,
      maxBuffer: 1024 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(stderr || `git ${args.join(' ')} failed`);
  }
}

function isSnapshotFile(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return (
    /\.(?:[cm]?ts|tsx|json)$/.test(normalized) &&
    !/(^|\/)(?:node_modules|dist|build|coverage|\.next|\.turbo)(\/|$)/.test(normalized)
  );
}
