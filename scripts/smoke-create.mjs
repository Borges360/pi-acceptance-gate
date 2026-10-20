// Load the real TypeScript entry point through Pi's own loader without credentials.
// Optional: --host-package /absolute/path/to/@earendil-works/pi-coding-agent
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { fakePi } from '../test-support/fakes.mjs';
import { loadTasks } from '../gate.mjs';

const hostArgument = process.argv.indexOf('--host-package');
const entry =
  hostArgument >= 0
    ? pathToFileURL(join(resolve(process.argv[hostArgument + 1]), 'dist/index.js')).href
    : pathToFileURL(createRequire(import.meta.url).resolve('@earendil-works/pi-coding-agent')).href;
const { DefaultResourceLoader, SettingsManager } = await import(entry);
const root = await mkdtemp(join(tmpdir(), 'acceptance-host-smoke-'));
const oldHome = process.env.PI_SUITE_HOME;
process.env.PI_SUITE_HOME = join(root, 'state');
let shutdown;
try {
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: join(root, 'agent'),
    settingsManager: SettingsManager.inMemory({}),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [fileURLToPath(new URL('../index.ts', import.meta.url))],
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  const loaded = result.extensions.find((e) => e.commands.has('acceptance'));
  assert.ok(loaded, 'real entry point registers /acceptance');
  const f = fakePi(root);
  f.ctx.ui.editor = async (_title, prefill) => prefill ?? 'Resultado observável e verificável';
  f.ctx.ui.input = async () => '';
  shutdown = async () => {
    for (const handler of loaded.handlers.get('session_shutdown') ?? []) await handler({}, f.ctx);
  };
  await loaded.commands.get('acceptance').handler('create', f.ctx);
  const tasks = await loadTasks(root);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].definitionOfDone.answers.length, 3);
  assert.ok(tasks[0].definitionOfDone.plan.length);
  console.log(
    'PASS: real Pi loader → index.ts → /acceptance create → reviewed YAML task (no model calls).',
  );
} finally {
  await shutdown?.();
  if (oldHome === undefined) delete process.env.PI_SUITE_HOME;
  else process.env.PI_SUITE_HOME = oldHome;
  await rm(root, { recursive: true, force: true });
}
