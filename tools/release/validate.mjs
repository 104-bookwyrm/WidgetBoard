#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRelease } from './lib.mjs';

function options(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (!['--tag', '--sha', '--notes'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('Usage: node tools/release/validate.mjs --tag vX.Y.Z --sha <commit> --notes <path>');
    }
    result[key.slice(2)] = args[++i];
  }
  if (!result.tag || !result.sha || !result.notes) throw new Error('Usage: node tools/release/validate.mjs --tag vX.Y.Z --sha <commit> --notes <path>');
  return result;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const gitRun = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const git = {
  tagTarget: (tag) => gitRun(['rev-parse', `${tag}^{commit}`]),
  isAncestor: (sha, ref) => {
    try { gitRun(['merge-base', '--is-ancestor', sha, ref]); return true; }
    catch { return false; }
  },
  status: (buildOutputs) => gitRun(['status', '--porcelain', '--untracked-files=all', '--', '.', ...buildOutputs.map((item) => `:(exclude)${item}`)])
    .split(/\r?\n/).filter(Boolean),
};

try {
  const args = options(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(validateRelease({ root, ...args, notesPath: args.notes, git }))}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
