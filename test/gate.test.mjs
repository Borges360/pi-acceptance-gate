import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { validate, verify, snapshot } from '../gate.mjs';
test('rejects arbitrary commands and duplicate criteria', () => {
  assert.throws(
    () => validate({ criteria: [{ id: '1', type: 'command', command: 'rm -rf .' }] }),
    /not allowed/,
  );
  assert.throws(
    () =>
      validate({
        criteria: [
          { id: '1', type: 'human' },
          { id: '1', type: 'human' },
        ],
      }),
    /duplicate/,
  );
});
test('explicit confirmation, real checks, human review, stale evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-gate-'));
  try {
    execFileSync('git', ['init', dir], { stdio: 'ignore' });
    await writeFile(join(dir, 'example.txt'), 'original');
    const contract = {
      criteria: [
        { id: 'A', type: 'command', command: 'node --test' },
        { id: 'B', type: 'human' },
      ],
    };
    await assert.rejects(verify(contract, dir, false), /confirmation/);
    const result = await verify(contract, dir, true, false);
    assert.equal(result.status, 'needs_human_review');
    const accepted = await verify(contract, dir, true, true);
    assert.equal(accepted.status, 'accepted');
    await writeFile(join(dir, 'example.txt'), 'modified');
    assert.notEqual(await snapshot(dir), accepted.snapshot);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
