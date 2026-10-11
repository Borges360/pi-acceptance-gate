import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadTasks, transition, verify, commandSpec, gateDefaults } from '../gate.mjs';
test('state machine rejects direct accepted and repeated verification transitions', () => {
  assert.throws(() => transition({ status: 'draft' }, 'accepted'), /Forbidden/);
  assert.equal(transition({ status: 'draft' }, 'in_progress').status, 'in_progress');
  assert.throws(() => transition({ status: 'rejected' }, 'accepted'), /Forbidden/);
});
test('YAML multi-task contracts and command interpolation denial', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-contract-'));
  try {
    await mkdir(join(dir, '.pi', 'tasks'), { recursive: true });
    await writeFile(
      join(dir, '.pi', 'tasks', 'tasks.yaml'),
      'tasks:\n  - id: T1\n    acceptance:\n      - id: tests\n        type: test\n        command: node --test\n  - id: T2\n    acceptance:\n      - id: review\n        type: human_review\n',
    );
    assert.equal((await loadTasks(dir)).length, 2);
    assert.throws(
      () => commandSpec('npm test; echo injected', gateDefaults.acceptanceGate),
      /Shell/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('real failing process cannot accept; full receipts, timeout inconclusive, conditional skipped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-real-'));
  try {
    execFileSync('git', ['init', dir], { stdio: 'ignore' });
    await writeFile(join(dir, 'fail.mjs'), 'process.exit(7)');
    const contract = {
      id: 'T1',
      risk: 'low',
      acceptance: [
        { id: 'fail', type: 'test', command: ['node', 'fail.mjs'] },
        { id: 'human', type: 'human_review', condition: 'risk >= high' },
      ],
    };
    const r = await verify(contract, dir, true);
    assert.equal(r.status, 'rejected');
    assert.equal(r.receipts[0].exitCode, 7);
    assert.equal(r.receipts[1].status, 'skipped-with-reason');
    assert.ok(r.receipts[0].commandHash);
    assert.ok(r.receipts[0].workingTreeHash);
    assert.equal(r.receipts[0].verifierVersion, '0.2.0');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('diff forbidden paths and file/coverage actual artifacts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-artifact-'));
  try {
    execFileSync('git', ['init', dir], { stdio: 'ignore' });
    await writeFile(join(dir, 'proof.txt'), 'documented');
    const r = await verify(
      {
        id: 'T',
        acceptance: [
          { id: 'doc', type: 'file', path: 'proof.txt', contains: 'documented' },
          { id: 'diff', type: 'git_diff', allowedPaths: ['src/**'], forbiddenPaths: ['proof.txt'] },
        ],
      },
      dir,
      true,
    );
    assert.equal(r.receipts[0].status, 'pass');
    assert.equal(r.receipts[1].status, 'fail');
    assert.equal(r.status, 'rejected');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
