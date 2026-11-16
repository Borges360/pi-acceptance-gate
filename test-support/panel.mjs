/**
 * Shared fixture for the panel-driven tests: a throwaway git project with contracts in
 * `.pi/tasks/`, a config seed in `.pi/pi-suite.yaml`, the fake TUI wired through the
 * `host` seam, and the real `extension.mjs` installed on a fake `pi`.
 *
 * Nothing here calls a model. Persistence is read back from the YAML file, because the
 * file is the promise the panel makes.
 */
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseDocument } from 'yaml';
import install from '../extension.mjs';
import { host } from '../menu.mjs';
import { fakeTui, withCustomUi } from './fake-tui.mjs';
import { fakePi } from './fakes.mjs';

export const CONTRACT_ONE = `task:
  id: TASK-001
  title: Verify the suite
  risk: moderate
  acceptance:
    - id: tests
      type: test
      command: node --test
      required: true
  maxAutoRevisions: 2
`;

export const CONTRACT_AUTH = `task:
  id: TASK-002
  title: Auth change
  risk: high
  acceptance:
    - id: diff
      type: git_diff
      allowedPaths:
        - src/auth/**
      forbiddenPaths:
        - src/legacy/**
      required: true
    - id: build
      type: build
      command: mvn verify
      required: true
  maxAutoRevisions: 3
`;

export const CONFIG = 'acceptanceGate:\n  enabled: true\n  scope: { source: available, strict: true }\n';

/**
 * @param t node:test context (registers cleanup)
 * @param {{contracts?: Record<string,string>, config?: string|null, global?: string|null}} [options]
 *   `global` is the content of `$PI_SUITE_HOME/config.yaml` — the only place a
 *   `locked:` block binds, because `rt.init` merges locks from the global file.
 */
export async function gateEnv(
  t,
  { contracts = { 'a.yaml': CONTRACT_ONE }, config = CONFIG, global = null } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'gate-panel-'));
  const old = process.env.PI_SUITE_HOME;
  process.env.PI_SUITE_HOME = join(dir, 'state');
  const savedHost = { tui: host.tui, agent: host.agent };
  t.after(async () => {
    process.env.PI_SUITE_HOME = old;
    host.tui = savedHost.tui;
    host.agent = savedHost.agent;
    await rm(dir, { recursive: true, force: true });
  });
  execFileSync('git', ['init', dir], { stdio: 'ignore' });
  await mkdir(join(dir, 'state'), { recursive: true });
  if (global) await writeFile(join(dir, 'state', 'config.yaml'), global);
  await writeFile(join(dir, 'README.md'), 'fixture\n');
  await mkdir(join(dir, '.pi', 'tasks'), { recursive: true });
  for (const [name, body] of Object.entries(contracts))
    await writeFile(join(dir, '.pi', 'tasks', name), body);
  if (config) await writeFile(join(dir, '.pi', 'pi-suite.yaml'), config);
  const tui = fakeTui();
  host.tui = tui.tuiPkg;
  host.agent = tui.agentPkg;
  const f = fakePi(dir);
  withCustomUi(f.ctx, tui);
  const command = (args) => f.command('gate', args);
  install(f.pi, undefined);
  await f.emit('session_start');
  const env = {
    dir,
    f,
    tui,
    command,
    /**
     * Bare `/gate`. The handler awaits config/git reads before it takes over the
     * screen, and the command promise only settles when the panel closes — so this
     * waits for the observable effect (a screen exists, or the command settled) and
     * hands back the still-pending command as `{ running }`. Awaiting it here would
     * deadlock: the panel is closed by the test later, not by the handler.
     */
    open: async () => {
      const settled = { done: false };
      const running = command('')
        .then((r) => {
          settled.done = true;
          return r;
        })
        .catch((e) => {
          settled.done = true;
          throw e;
        });
      await waitFor(() => f.ctx.lastScreen || settled.done, 'abrir o painel (ou degradar)');
      return { running };
    },
    /** The `SettingsList` the dashboard built. */
    settings: () => tui.created.settings[0],
    saved: async () =>
      (parseDocument(await readFile(join(dir, '.pi', 'pi-suite.yaml'), 'utf8')).toJS() ?? {})
        .acceptanceGate,
    file: async () => {
      try {
        return await readFile(join(dir, '.pi', 'pi-suite.yaml'), 'utf8');
      } catch {
        return '';
      }
    },
  };
  return env;
}

/** A promise that resolves when the write the panel started has landed on disk. */
export async function waitFor(predicate, what, ms = 4000) {
  const until = Date.now() + ms;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > until) throw Error(`timeout aguardando: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
