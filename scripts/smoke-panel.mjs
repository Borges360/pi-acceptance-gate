/**
 * Real-host smoke for the `/gate` panel.
 *
 * The unit tests drive a hand-written double (`test-support/fake-tui.mjs`). That double
 * is faithful only if somebody read the host: in the economist the fake shipped
 * `DynamicBorder` inside `tuiPkg` while the real host exports it from
 * `@earendil-works/pi-coding-agent` (`dist/index.d.ts:36`; `pi-tui/dist/index.d.ts:32`
 * exports `Container`, not it). `new DynamicBorder(...)` then threw inside
 * `ctx.ui.custom()` — no menu for the user, 49 green unit tests. Only the real modules
 * catch that class of bug, so this script uses the INSTALLED pi: its own extension
 * loader (jiti plus the host module map), the real `pi-tui` components, the real theme
 * and the real keybindings, and drives the screen with terminal bytes (↓ / Enter / Ctrl+S / Esc)
 * the way a human does.
 *
 * It never calls a model: the gate's whole surface is local commands and checkers, and
 * the verification it runs is a `git_diff` plus `node -e "process.exit(0)"` — free and
 * offline by construction.
 *
 *   node scripts/smoke-panel.mjs       # optionally PI_CODING_AGENT_ENTRY=<pi>/dist/index.js
 *
 * Exit 0 with the screens and the decisions on stdout; exit 1 on any mismatch.
 */
import { mkdtemp, rm, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { piExtensions } from './pi-module.mjs';
import { fakePi } from '../test-support/fakes.mjs';
import { HOST_EXPORTS, missingHostExports, panelItems, FIELDS } from '../menu.mjs';
import { gateDefaults } from '../gate.mjs';

const DOWN = '\x1b[B';
const ENTER = '\r';
const CTRL_S = '\x13';
const ESC = '\x1b';
const url = (p) => pathToFileURL(p).href;
const firstLine = (t) => String(t).split('\n')[0];
/** ANSI stripped so the evidence lines stay readable in a terminal or a commit body. */
const strip = (line) => String(line).replace(/\x1b\[[0-9;]*m/g, '');

async function exists(path) {
  try {
    return (await readFile(path)) && path;
  } catch {
    return undefined;
  }
}

/** Locate the installed pi-coding-agent's dist/index.js (same search as pi-module.mjs). */
async function agentEntry() {
  const releases = join(homedir(), '.pi', 'agent', 'install', 'releases');
  const candidates = [
    process.env.PI_CODING_AGENT_ENTRY,
    ...(await readdir(releases)
      .catch(() => [])
      .then((versions) =>
        versions
          .sort()
          .reverse()
          .map((v) =>
            join(releases, v, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js'),
          ),
      )),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const path = candidate.replace(/[/\\]$/, '').replace(/[\\/]dist[/\\]?$/, '/dist/index.js');
    if (await exists(path)) return path;
  }
  throw Error('installed pi-coding-agent/dist/index.js not found; set PI_CODING_AGENT_ENTRY');
}

/** The real host modules, imported by path so nothing depends on this repo's node_modules. */
async function realModules() {
  const entry = await agentEntry();
  const dist = dirname(entry);
  const agent = await import(url(entry));
  const theme = await import(url(join(dist, 'modes', 'interactive', 'theme', 'theme.js')));
  let tui;
  for (const candidate of [
    join(dist, '..', '..', 'pi-tui', 'dist', 'index.js'),
    join(dist, '..', '..', '..', 'pi-tui', 'dist', 'index.js'),
  ]) {
    try {
      const mod = await import(url(candidate));
      if (mod.SettingsList && mod.Container && mod.Input && mod.getKeybindings) {
        tui = mod;
        break;
      }
    } catch {
      /* next candidate */
    }
  }
  if (!tui) throw Error('installed pi-tui not importable from the pi release directory');
  return { entry, dist, agent, theme, tui };
}

const CONTRACTS = {
  'a-suite.yaml': `task:
  id: TASK-001
  title: Verify the suite
  risk: moderate
  acceptance:
    - { id: diff, type: git_diff, allowedPaths: ["src/**"], required: true }
  maxAutoRevisions: 2
`,
  'b-auth.yaml': `task:
  id: TASK-002
  title: Auth change
  risk: high
  acceptance:
    - { id: tests, type: test, command: 'node -e "process.exit(0)"', required: true }
  maxAutoRevisions: 3
`,
};

const run = async () => {
  const host = await realModules();
  console.log(`host: ${host.entry}`);
  // Prove the shape we rely on before anything else: which export lives where.
  for (const name of HOST_EXPORTS['@earendil-works/pi-tui'])
    console.log(`  pi-tui.${name}: ${typeof host.tui[name]}`);
  for (const name of [...HOST_EXPORTS['@earendil-works/pi-coding-agent'], 'keyHint', 'keyText'])
    console.log(`  pi-coding-agent.${name}: ${typeof host.agent[name]}`);
  const table = missingHostExports(host.tui, host.agent);
  if (table.length) throw Error(`host module shape changed: missing ${table.join(', ')}`);

  // The real pi loader: jiti plus the host module mapping, exactly as at runtime. This is
  // what a dynamic `await import('@earendil-works/pi-tui')` from inside the extension
  // cannot reach — the map applies to static imports (see index.ts).
  const { loadExtensions, createExtensionRuntime } = await piExtensions();
  const entry = join(process.cwd(), 'index.ts');
  const loaded = await loadExtensions([entry], process.cwd(), undefined, createExtensionRuntime());
  if (loaded.errors?.length)
    throw Error(`extension did not load: ${loaded.errors.map((e) => e.error ?? e).join('; ')}`);
  const command = loaded.extensions
    .flatMap((e) => [...e.commands.values()])
    .find((c) => c.name === 'gate');
  if (!command) throw Error('the real loader did not register /gate');

  host.theme.initTheme?.();
  const theme = host.theme.theme;
  const keybindings = host.tui.getKeybindings();

  const dir = await mkdtemp(join(tmpdir(), 'gate-smoke-'));
  const old = process.env.PI_SUITE_HOME;
  process.env.PI_SUITE_HOME = join(dir, 'state');
  try {
    execFileSync('git', ['init', dir], { stdio: 'ignore' });
    await mkdir(join(dir, 'state'), { recursive: true });
    await mkdir(join(dir, '.pi', 'tasks'), { recursive: true });
    await mkdir(join(dir, 'src', 'auth'), { recursive: true });
    await writeFile(join(dir, 'src', 'auth', 'login.ts'), 'export const x = 1;\n');
    await writeFile(
      join(dir, '.pi', 'pi-suite.yaml'),
      'acceptanceGate:\n  enabled: true\n  scope: { source: available, strict: true }\n',
    );
    for (const [name, body] of Object.entries(CONTRACTS))
      await writeFile(join(dir, '.pi', 'tasks', name), body);

    const notes = [];
    const f = fakePi(dir);
    f.ctx.scopedModels = [];
    f.ctx.ui.notify = (text) => notes.push(String(text));
    f.ctx.ui.setStatus = () => {};
    f.ctx.ui.confirm = async () => true;
    let screen = null;
    let close;
    const closed = new Promise((resolve) => (close = resolve));
    f.ctx.ui.custom = (factory) => {
      screen = factory({ requestRender: () => {} }, theme, keybindings, (result) => close(result));
      return closed;
    };
    const ctx = f.ctx;
    const show = (label, limit = 34) => {
      console.log(`\n──── ${label}`);
      if (!screen) {
        console.log('   (nenhuma tela: /gate não abriu painel)');
        return;
      }
      for (const line of screen.render(96).slice(0, limit)) console.log(`   ${strip(line)}`);
    };
    const send = (bytes) => screen.handleInput(bytes);
    const saved = () => readFile(join(dir, '.pi', 'pi-suite.yaml'), 'utf8').catch(() => '(sem arquivo)');
    /**
     * The panel writes through promises the UI never awaits (a real keypress has no
     * promise to hang on). Wait for the observable effect — the file on disk, or the
     * screen existing — instead of counting ticks: a deadline on a real side effect is
     * deterministic, a tick budget is not.
     */
    const waitFor = async (predicate, what, ms = 8000) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (await predicate()) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw Error(`timeout aguardando: ${what}`);
    };
    const decision = async (label, args = 'status') => {
      await command.handler(args, ctx);
      console.log(`\n${label}`);
      for (const line of String(notes.at(-1)).split('\n')) console.log('   ' + strip(line));
    };

    await decision('DECISÃO ANTES DO PAINEL (contrato, por quê, escopo, clamp de continuações):');
    const before = await saved();

    // Where the smoke clicks is read from the same table the panel is built from, so a
    // change in `FIELDS` moves the keystrokes instead of breaking a literal.
    const rows = panelItems({
      conf: gateDefaults.acceptanceGate,
      locked: {},
      state: { contract: null, ranked: { scored: [] } },
    }).map((r) => r.id);
    const rowIndex = (id) => rows.indexOf(id);
    const scopeRow = rowIndex('scopeSource');
    const contractRow = rowIndex('contract');
    if (scopeRow < 0 || contractRow < 0)
      throw Error(`linhas esperadas não estão na tabela: scopeSource=${scopeRow} contract=${contractRow}`);
    /**
     * The cursor starts at 0 and `↓` moves it by one, wrapping at the end
     * (`settings-list.js:170-184`), so the script tracks it instead of guessing: same
     * arithmetic the component does, on the row list the table produced.
     */
    let cursor = 0;
    const goto = (index) => {
      const steps = (index - cursor + rows.length) % rows.length;
      for (let i = 0; i < steps; i++) send(DOWN);
      cursor = index;
      return steps;
    };

    const running = command.handler('', ctx);
    await waitFor(() => screen, 'a tela do painel aparecer');
    for (const width of [40, 80, 120]) {
      const rendered = screen.render(width).map(strip);
      if (!rendered.some((line) => line.includes('Gate')))
        throw Error(`o painel real não renderizou em ${width} colunas`);
      if (typeof host.tui.visibleWidth === 'function' && rendered.some((line) => host.tui.visibleWidth(line) > width))
        throw Error(`uma linha excede ${width} colunas`);
      if (width === 40 && !rendered.join('\n').includes('10 allowed'))
        throw Error('o painel estreito cortou o valor da allowlist em vez de compactar o rótulo');
      if (width === 120 && !/continuações|continuations/i.test(rendered.join('\n')))
        throw Error('o título em largura ampla perdeu texto Unicode');
    }
    console.log('render Pi 1.4.0 em 40/80/120 colunas e texto Unicode: PASS');
    show('painel aberto com /gate (vazio)');

    console.log(`\n(cursor 0 → ${goto(scopeRow)}× ↓ até "Escopo do gate")`);
    show(`após ir à linha ${scopeRow}: "Escopo do gate"`);
    send(ENTER);
    await waitFor(
      async () => /Rascunho|Draft/.test(screen.render(96).join('\n')),
      'o rascunho do escopo aparecer',
    );
    if ((await saved()) !== before) throw Error('Enter gravou antes de Ctrl+S');
    show('após Enter no enum (valor ciclado apenas no rascunho)');
    send(CTRL_S);
    await waitFor(async () => (await saved()) !== before, 'Ctrl+S ter persistido o valor do escopo');
    show('após Ctrl+S (configuração validada e persistida)');
    const afterScope = await saved();
    if (afterScope === before) throw Error('Enter ciclou o escopo mas nada foi persistido');
    if (!/source: (declared|available)/.test(afterScope))
      throw Error(`o arquivo não traz acceptanceGate.scope.source:\n${afterScope}`);

    // Two levels with navigateTo: pick a contract and its checkers open by themselves.
    console.log(`\n(cursor ${cursor} → ${goto(contractRow)}× ↓ até "Contrato desta sessão")`);
    send(ENTER);
    show('submenu "Contrato desta sessão" aberto (▸ recomendado no primeiro)');
    send(ENTER); // picks the first row → done(value, { navigateTo: 'checkers' })
    await new Promise((r) => setImmediate(r));
    // `settings-list.js:222-233`: navigateTo re-selects AND activates the target, so the
    // second level is already open here — pressing enter again would pick one of its rows.
    show('segundo nível aberto pelo navigateTo ("Checkers do contrato")');
    send(ESC);
    await new Promise((r) => setImmediate(r));
    show('após Esc: voltou um nível — o painel continua aberto');

    send(ESC); // on the main list, Esc closes with the summary
    const summary = await closed;
    console.log('\nFECHAMENTO →', JSON.stringify(summary));
    console.log('ÚLTIMAS NOTAS →', JSON.stringify(notes.slice(-4).map(firstLine)));
    await running;

    await decision('DECISÃO DEPOIS DO PAINEL (mesma pergunta, escopo novo):');
    await decision('VERIFICAÇÃO DEPOIS DO PAINEL (checkers locais, nenhum modelo):', 'check');
    const finalFile = await saved();
    const decided = parse(finalFile).acceptanceGate ?? {};
    const was = parse(before).acceptanceGate ?? {};
    console.log(
      `\nANTES  scope.source=${was.scope?.source} · strict=${was.scope?.strict} · continuações=${was.maxAutoRevisions ?? 'default'}`,
    );
    console.log(
      `DEPOIS scope.source=${decided.scope?.source} · strict=${decided.scope?.strict} · continuações=${decided.maxAutoRevisions ?? 'default'} (o painel só tocou em acceptanceGate.scope.source)`,
    );
    console.log('\nARQUIVO FINAL GRAVADO PELO PAINEL:\n' + finalFile.trimEnd());
    console.log('\nOK: menu abriu, navegou, decidiu, persistiu e fechou com resumo contra o host real.');
  } finally {
    if (old === undefined) delete process.env.PI_SUITE_HOME;
    else process.env.PI_SUITE_HOME = old;
    await rm(dir, { recursive: true, force: true });
  }
};

run().catch((error) => {
  console.error('SMOKE FALHOU:', error?.stack ?? error);
  process.exitCode = 1;
});
