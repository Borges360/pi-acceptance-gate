import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
test('CI JSON exit codes: unapproved 2, accepted 0, human pending 3, rejected 1', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-cli-'));
  const state = await mkdtemp(join(tmpdir(), 'gate-cli-state-'));
  try {
    execFileSync('git', ['init', dir], { stdio: 'ignore' });
    await mkdir(join(dir, '.pi', 'tasks'), { recursive: true });
    await writeFile(join(dir, 'doc.txt'), 'valid');
    const contract = join(dir, '.pi', 'tasks', 't.yaml');
    const run = (approved) =>
      spawnSync(
        process.execPath,
        [resolve('cli.mjs'), '--cwd', dir, '--task', 'T', ...(approved ? ['--approve'] : [])],
        { env: { ...process.env, PI_SUITE_HOME: state }, encoding: 'utf8' },
      );
    await writeFile(
      contract,
      'task:\n  id: T\n  acceptance:\n    - id: file\n      type: file\n      path: doc.txt\n',
    );
    let result = run(false);
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).status, 'not-run');
    result = run(true);
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).status, 'accepted');
    await writeFile(
      contract,
      'task:\n  id: T\n  acceptance:\n    - id: review\n      type: human_review\n',
    );
    result = run(true);
    assert.equal(result.status, 3);
    await writeFile(
      contract,
      'task:\n  id: T\n  acceptance:\n    - id: file\n      type: file\n      path: missing.txt\n',
    );
    result = run(true);
    assert.equal(result.status, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});
