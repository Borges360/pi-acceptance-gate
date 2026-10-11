import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakePi } from '../test-support/fakes.mjs';
import gate from '../extension.mjs';

const contract = (id, risk, title) =>
  `task:\n  id: ${id}\n  title: ${title}\n  risk: ${risk}\n  acceptance:\n    - id: tests\n      type: test\n      command: [node, --test]\n      required: true\n  maxAutoRevisions: 2\n`;

test('/gate use completes with the task ids that actually exist in this repo', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-complete-'));
  const old = process.env.PI_SUITE_HOME;
  process.env.PI_SUITE_HOME = join(dir, 'state');
  t.after(async () => {
    process.env.PI_SUITE_HOME = old;
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(join(dir, '.pi', 'tasks'), { recursive: true });
  execFileSync('git', ['init', dir], { stdio: 'ignore' });
  await writeFile(join(dir, '.pi', 'tasks', 'TASK-001.yaml'), contract('TASK-001', 'high', 'Pagina'));
  await writeFile(
    join(dir, '.pi', 'tasks', 'TASK-002.yaml'),
    contract('TASK-002', 'low', 'Cache'),
  );

  const f = fakePi(dir, []);
  gate(f.pi);
  // session_start is what loads the contracts; no command has to run first.
  await f.emit('session_start');
  const cmd = [...f.commands.values()][0];
  const items = await cmd.getArgumentCompletions('use ');
  assert.deepEqual(items.map((i) => i.label).sort(), ['TASK-001', 'TASK-002']);
  const high = items.find((i) => i.label === 'TASK-001');
  assert.match(high.description, /high/);
  assert.match(high.description, /1 checker/);

  // The selected task is marked so the list reads like a status line.
  await f.command('gate', 'use TASK-002');
  const again = await cmd.getArgumentCompletions('use ');
  assert.match(again.find((i) => i.label === 'TASK-002').description, /selected/);
});

test('an untrusted project lists no contracts and says so instead of offering nothing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-untrusted-'));
  const old = process.env.PI_SUITE_HOME;
  process.env.PI_SUITE_HOME = join(dir, 'state');
  t.after(async () => {
    process.env.PI_SUITE_HOME = old;
    await rm(dir, { recursive: true, force: true });
  });
  const f = fakePi(dir, []);
  f.ctx.isProjectTrusted = () => false;
  gate(f.pi);
  // Completion must work head-of-session, before any command has run.
  await f.emit('session_start');
  const cmd = [...f.commands.values()][0];
  assert.equal(await cmd.getArgumentCompletions('use '), null);
  await assert.rejects(
    () => f.command('gate', 'use'),
    (e) => {
      assert.match(e.message, /not trusted|gate init/);
      return true;
    },
  );
});
