import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import install from '../extension.mjs';
import { fakePi } from '../test-support/fakes.mjs';
test('human approval bound to snapshot and contract, report journal kept, stale evidence detected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-runtime-'));
  const old = process.env.PI_SUITE_HOME;
  process.env.PI_SUITE_HOME = join(tmpdir(), `gate-state-${Date.now()}`);
  try {
    execFileSync('git', ['init', dir], { stdio: 'ignore' });
    await mkdir(join(dir, '.pi', 'tasks'), { recursive: true });
    await writeFile(join(dir, 'doc.txt'), 'ok');
    await writeFile(
      join(dir, '.pi', 'tasks', 't.yaml'),
      'task:\n  id: T1\n  acceptance:\n    - id: doc\n      type: file\n      path: doc.txt\n    - id: human\n      type: human_review\n',
    );
    const f = fakePi(dir);
    install(f.pi);
    await f.emit('session_start');
    await f.command('gate', 'check');
    assert.match(f.notifications.at(-1), /needs_human_review/);
    await f.command('gate', 'approve Reviewed document');
    await f.command('gate', 'check');
    assert.match(f.notifications.at(-1), /accepted/);
    await writeFile(join(dir, 'doc.txt'), 'changed');
    await f.command('gate', 'status');
    assert.match(f.notifications.at(-1), /stale/);
    await f.emit('session_shutdown');
  } finally {
    await rm(process.env.PI_SUITE_HOME, { recursive: true, force: true });
    if (old === undefined) delete process.env.PI_SUITE_HOME;
    else process.env.PI_SUITE_HOME = old;
    await rm(dir, { recursive: true, force: true });
  }
});
