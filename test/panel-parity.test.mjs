import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { gateEnv, CONTRACT_ONE, CONTRACT_AUTH } from '../test-support/panel.mjs';

const gateEnvPt = async (t, options) => {
  const env = await gateEnv(t, options);
  await writeFile(join(env.dir, '.pi', 'pi-acceptance-gate.locale.json'), JSON.stringify({ uiLanguage: 'pt-BR' }));
  return env;
};
import {
  FIELDS,
  HOST_EXPORTS,
  missingHostExports,
  fieldValues,
  panelItems,
  enumItems,
  c0,
  host,
  runDashboard,
} from '../menu.mjs';


/**
 * The parity test, and the reason this file exists.
 *
 * It cycles **every value of every enum row the panel offers** and reads the config file
 * back. A row can therefore never advertise a value the writer refuses, which is exactly
 * the bug that shipped in the economist: the `selected-as` row listed the declared
 * default, `FIELDS.patch` rejected it, nothing was saved — and 49 tests stayed green
 * because the panel, the command and the fake each carried their own copy of the list.
 */
test('every value the panel offers is accepted by the shared table and remains a draft until Ctrl+S', async (t) => {
  const env = await gateEnvPt(t, {
    contracts: { 'a.yaml': CONTRACT_ONE, 'b.yaml': CONTRACT_AUTH },
  });
  const { running } = await env.open();
  const settings = env.settings();
  const original = await env.file();
  const rows = settings.items.filter((i) => i.id !== 'uiLanguage' && Array.isArray(i.values) && i.values.length);
  assert.ok(rows.length >= 9, `esperava pelo menos 9 linhas enum, achei ${rows.length}`);
  const expected = [];
  for (const row of rows) {
    for (const value of row.values) await settings.cycle(row.id, value);
    assert.equal(await env.file(), original, `${row.id}: navegar/editar não pode gravar antes de Ctrl+S`);
    expected.push([row.id, row.values.at(-1)]);
  }
  await env.f.ctx.lastScreen.handleInput('\u0013');
  const written = await env.saved();
  for (const [id, expectedValue] of expected) {
    const readBack = FIELDS[id].current(written);
    assert.equal(
      readBack,
      expectedValue,
      `${id}: o painel ofereceu valores pela tabela e o último valor não chegou ao arquivo (o arquivo diz ${readBack})`,
    );
  }
  // And the defaults the README declares are reachable from the panel, not only from
  // the file: a declared default that is not in its own row is a lie in the docs.
  for (const id of Object.keys(FIELDS)) {
    if (FIELDS[id].kind === 'list') continue;
    assert.ok(
      fieldValues(id, c0()).includes(FIELDS[id].current(c0())),
      `${id}: o default declarado não está entre os valores oferecidos`,
    );
  }
  settings.onCancel();
  await running;
});

test('the screen has no values of its own: rows are the table, in table order', () => {
  const conf = { ...c0(), allowedExecutables: ['node', 'mvn'] };
  const rows = panelItems({ conf, locked: {}, state: {}, languageEnabled: false });
  const enums = rows.filter((r) => Array.isArray(r.values) && r.values.length);
  assert.deepEqual(
    enums.map((r) => r.id),
    enumItems({ conf }).map((r) => r.id),
  );
  for (const row of enums)
    assert.deepEqual(
      row.values,
      fieldValues(row.id, conf),
      `${row.id}: a linha carrega uma lista própria — é assim que painel e escrita divergem`,
    );
});

test('the dashboard renders Unicode labels at narrow, default, and wide terminal widths', async (t) => {
  const env = await gateEnvPt(t);
  const { running } = await env.open();
  const screen = env.f.ctx.lastScreen;
  await env.settings().cycle('scopeSource', 'declared');
  for (const width of [40, 80, 120]) {
    const rendered = screen.render(width).join('\n');
    assert.match(rendered, /Escopo do gate/);
    assert.match(rendered, /Ctrl\+S/);
    assert.doesNotMatch(rendered, /\uFFFD/, `render de ${width} colunas não deve corromper texto Unicode`);
  }
  assert.match(screen.render(120).join('\n'), /continuações/i);
  await screen.handleInput('\u001b');
  await screen.handleInput('\u001b');
  await running;
});

test('a narrow dashboard keeps current values visible without persisting compact labels', async (t) => {
  const env = await gateEnv(t);
  const { running } = await env.open();
  const screen = env.f.ctx.lastScreen;
  const selection = env.settings().find('autoSelect');
  const fullLabel = selection.label;

  const narrow = screen.render(40).join('\n');
  assert.match(narrow, /10 allowed/, 'the allowlist count remains readable at 40 columns');
  assert.match(narrow, /Automatic contr…/, 'only the displayed label is compacted');
  assert.equal(selection.label, fullLabel, 'the row keeps its canonical label after rendering');

  const wide = screen.render(80).join('\n');
  assert.match(wide, /Automatic contract selection/);
  assert.match(wide, /10 allowed/);
  assert.equal(selection.label, fullLabel, 'wide rendering also leaves the row unchanged');

  await screen.handleInput('\u001b');
  await running;
});

test('a late action callback cannot notify or overwrite a newly opened dashboard', async (t) => {
  const env = await gateEnvPt(t);
  let resolveAction;
  const delayed = new Promise((resolve) => { resolveAction = resolve; });
  const firstRun = runDashboard({
    ctx: env.f.ctx,
    title: 'Primeiro painel',
    items: [{ id: 'delayed', label: 'Ação atrasada', currentValue: '—', values: ['go'] }],
    menus: {},
    onChange: () => delayed,
  }, { tuiPkg: env.tui.tuiPkg, agentPkg: env.tui.agentPkg });
  const firstScreen = env.f.ctx.lastScreen;
  const notificationsBefore = env.f.notifications.length;
  const pending = env.tui.created.settings.at(-1).cycle('delayed', 'go');
  await firstScreen.handleInput('\u001b');
  const firstResult = await firstRun;
  assert.deepEqual(firstResult.changed, []);

  const secondRun = runDashboard({
    ctx: env.f.ctx,
    title: 'Segundo painel',
    items: [{ id: 'ready', label: 'Ação pronta', currentValue: '—', values: ['go'] }],
    menus: {},
    onChange: () => 'segunda tela ativa',
  }, { tuiPkg: env.tui.tuiPkg, agentPkg: env.tui.agentPkg });
  const secondScreen = env.f.ctx.lastScreen;
  resolveAction('retorno atrasado');
  await pending;
  assert.match(secondScreen.render(80).join('\n'), /Segundo painel/);
  assert.doesNotMatch(secondScreen.render(80).join('\n'), /retorno atrasado/);
  assert.equal(env.f.notifications.length, notificationsBefore, 'o callback antigo não publica status na nova tela');
  await secondScreen.handleInput('\u001b');
  await secondRun;
});

test('a panel edit stays in a draft until an explicit save', async (t) => {
  const env = await gateEnvPt(t);
  const { running } = await env.open();
  const original = await env.file();
  await env.settings().cycle('scopeSource', 'declared');
  assert.equal(await env.file(), original, 'a edição só muda o rascunho');
  assert.match(env.f.ctx.lastScreen.render(90).join('\n'), /Rascunho/);
  await env.f.ctx.lastScreen.handleInput('\u0013');
  settings(env).onCancel();
  await running;
  assert.match(env.f.notifications.join('\n'), /já em efeito/);
  assert.doesNotMatch(
    env.f.notifications.join('\n'),
    /\/reload/i,
    'rt.save mergeia na config viva; mandar recarregar ensina o usuário a duvidar de um comando que acabou de funcionar',
  );
  assert.equal((await env.saved()).scope.source, 'declared');
});

test('an invalid on-disk config rejects the save but keeps the draft visible and the panel open', async (t) => {
  const env = await gateEnvPt(t);
  const { running } = await env.open();
  const row = env.settings().find('scopeSource');
  await env.settings().cycle('scopeSource', 'declared');
  await writeFile(join(env.dir, '.pi', 'pi-suite.yaml'), 'acceptanceGate:\n  enabled: true\n  approvalTtlSeconds: 0\n  scope: { source: available, strict: true }\n');

  await env.f.ctx.lastScreen.handleInput('\u0013');

  assert.equal(row.currentValue, 'declared', 'a falha não apaga o rascunho');
  assert.match(env.f.ctx.lastScreen.render(100).join('\n'), /Falha ao salvar: Invalid numeric policy: approvalTtlSeconds/);
  assert.equal(env.f.ctx.customResult, undefined, 'a tela continua utilizável após a validação falhar');
  assert.match(await env.file(), /approvalTtlSeconds: 0/, 'a validação não reescreve a configuração inválida');
  await env.f.ctx.lastScreen.handleInput('\u001b');
  await env.f.ctx.lastScreen.handleInput('\u001b');
  await running;
});

test('a write error preserves the draft and leaves the panel interactive', async (t) => {
  const env = await gateEnvPt(t);
  const { running } = await env.open();
  const row = env.settings().find('scopeSource');
  await env.settings().cycle('scopeSource', 'declared');
  const configPath = join(env.dir, '.pi', 'pi-suite.yaml');
  await rm(configPath);
  await mkdir(configPath);

  await env.f.ctx.lastScreen.handleInput('\u0013');

  assert.equal(row.currentValue, 'declared', 'a falha de escrita não descarta o rascunho');
  assert.match(env.f.ctx.lastScreen.render(100).join('\n'), /Falha ao salvar:/);
  assert.equal(env.f.ctx.customResult, undefined, 'a tela permanece aberta após o erro de I/O');
  await env.f.ctx.lastScreen.handleInput('\u001b');
  await env.f.ctx.lastScreen.handleInput('\u001b');
  await running;
});

const settings = (env) => env.settings();

test('the host surface the screen needs is pinned per package (provenance guard)', () => {
  assert.deepEqual(HOST_EXPORTS['@earendil-works/pi-tui'], [
    'Container',
    'SettingsList',
    'SelectList',
    'Text',
    'Input',
    'matchesKey',
  ]);
  assert.ok(
    HOST_EXPORTS['@earendil-works/pi-coding-agent'].includes('DynamicBorder'),
    'DynamicBorder é export do pi-coding-agent, não do pi-tui (pi-coding-agent/dist/index.d.ts:36-37)',
  );
  assert.equal(missingHostExports(undefined, undefined).length, 9);
  assert.deepEqual(missingHostExports({}, {}), [
    '@earendil-works/pi-tui.Container',
    '@earendil-works/pi-tui.SettingsList',
    '@earendil-works/pi-tui.SelectList',
    '@earendil-works/pi-tui.Text',
    '@earendil-works/pi-tui.Input',
    '@earendil-works/pi-tui.matchesKey',
    '@earendil-works/pi-coding-agent.DynamicBorder',
    '@earendil-works/pi-coding-agent.getSettingsListTheme',
    '@earendil-works/pi-coding-agent.getSelectListTheme',
  ]);
});

test('a missing host export degrades to the text panel and says which one, instead of throwing', async (t) => {
  const env = await gateEnvPt(t);
  // The real host does not export DynamicBorder from pi-tui; deleting it from the agent
  // module reproduces a host that exposes even less than we expect.
  delete host.agent.DynamicBorder;
  assert.deepEqual(missingHostExports(env.tui.tuiPkg, host.agent), [
    '@earendil-works/pi-coding-agent.DynamicBorder',
  ]);
  await env.command('');
  assert.ok(!env.f.ctx.lastScreen, 'nenhuma tela customizada foi montada');
  assert.match(
    env.f.notifications.join('\n'),
    /sem painel interativo.*DynamicBorder/,
    'a degradação precisa nomear o export ausente',
  );
  const fallback = env.f.notifications.at(-1);
  assert.match(fallback, /Gate ·/);
  assert.ok(
    fallback.indexOf('contrato:') < fallback.indexOf('/gate check'),
    'o painel de fallback mostra estado (contrato, escopo, continuações) antes das linhas de comando',
  );
  assert.match(
    fallback,
    /continuações 1 \(teto global 1\)|continuações 1\b/,
    'o clamp de continuações é exibido, não escondido numa closure',
  );
});

test('the pi entry point imports the host modules statically and hands them to the extension', async () => {
  // A dynamic `await import('@earendil-works/pi-tui')` from inside an extension is
  // resolved by Node, not by pi's jiti host-module map
  // (`pi-coding-agent/dist/core/extensions/loader.js:55-79`, `virtual-modules.js:21,31`),
  // and dies with ERR_MODULE_NOT_FOUND — proved against the installed 1.1.0 by
  // scripts/smoke-panel.mjs. So the entry point supplies the modules; if anyone moves
  // that back to a lazy-only import, this test says why not.
  const entry = await readFile(new URL('../index.ts', import.meta.url), 'utf8');
  assert.match(entry, /import \* as piTui from ['"]@earendil-works\/pi-tui['"]/);
  assert.match(entry, /import \* as piAgent from ['"]@earendil-works\/pi-coding-agent['"]/);
  assert.match(entry, /install\(pi, Type, \{ tui: piTui, agent: piAgent \}\)/);
  const extension = await readFile(new URL('../extension.mjs', import.meta.url), 'utf8');
  assert.match(extension, /provideHost\(injected\.tui, injected\.agent\)/);
  const menu = await readFile(new URL('../menu.mjs', import.meta.url), 'utf8');
  assert.match(menu, /export function provideHost\(tui, agent\)/);
});

test('a locked key disappears from the panel and is refused by the command too', async (t) => {
  const env = await gateEnvPt(t, {
    global: 'locked:\n  acceptanceGate:\n    maxAutoRevisions: 1\n',
  });
  const { running } = await env.open();
  const rows = settings(env).items.map((i) => i.id);
  assert.ok(!rows.includes('maxAutoRevisions'), 'linha travada some do painel');
  assert.ok(rows.includes('scopeSource'), 'o que não está travado continua lá');
  settings(env).onCancel();
  await running;
  await assert.rejects(env.command('revisions 2'), /travado por política global/);
  assert.ok(
    !env.f.notifications.some((n) => /salvo em/.test(String(n))),
    'um campo travado não escreve nada em lugar nenhum',
  );
});

test('a non-tui client never reaches the panel and still gets state before grammar', async (t) => {
  const env = await gateEnvPt(t);
  // `rpc` keeps the UI helpers but has no custom screen (`types.d.ts:212` — the modes
  // are tui | rpc | json | print), so the panel must decline and the text panel must
  // answer instead of dumping the grammar.
  env.f.ctx.mode = 'rpc';
  const { running } = await env.open();
  assert.equal(env.tui.created.settings.length, 0, 'sem TUI, nenhuma tela é montada');
  await running;
  const text = env.f.notifications.at(-1);
  assert.match(text, /Gate ·/);
  assert.ok(text.indexOf('contrato:') < text.indexOf('/gate check'));
  await assert.rejects(env.command('scope sometimes'), /Invalid scopeSource/);
});
