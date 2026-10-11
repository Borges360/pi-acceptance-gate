#!/usr/bin/env node
import { loadTasks, verify, gateDefaults } from './gate.mjs';
import { projectIdentity, FileStore, uid, hash, yamlFile, merge } from './lib/core.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const args = process.argv.slice(2);
const get = (key, fallback) => {
  const i = args.indexOf(key);
  return i < 0 ? fallback : args[i + 1];
};
try {
  const { root, projectId } = await projectIdentity(get('--cwd', process.cwd()));
  const home = process.env.PI_SUITE_HOME ?? join(homedir(), '.pi', 'agent', 'pi-suite');
  const global = await yamlFile(join(home, 'config.yaml'), true);
  const local = args.includes('--approve')
    ? await yamlFile(join(root, '.pi', 'pi-suite.yaml'), true)
    : {};
  const config = merge(merge(merge(gateDefaults, global), local), global.locked ?? {});
  const tasks = await loadTasks(root);
  const task = tasks.find((t) => t.id === get('--task', tasks[0]?.id));
  if (!task) throw Error('Unknown task');
  const store = new FileStore(join(home, 'projects', projectId));
  const report = await verify(task, root, args.includes('--approve'), false, {
    config: config.acceptanceGate,
    onReceipt: (r) =>
      store.append('gate-receipts', { ...r, taskId: task.id, sessionId: 'ci', attemptId: uid() }),
  });
  await store.append('tasks', {
    id: uid(),
    entityId: `ci/${task.id}`,
    taskId: task.id,
    status: report.status,
    report,
  });
  process.stdout.write(JSON.stringify(report) + '\n');
  process.exitCode =
    report.status === 'accepted' ? 0 : report.status === 'needs_human_review' ? 3 : 1;
} catch (e) {
  process.stdout.write(JSON.stringify({ status: 'not-run', error: e.message }) + '\n');
  process.exitCode = 2;
}
