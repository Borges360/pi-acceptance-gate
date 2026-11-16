import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gateEnv, CONTRACT_ONE, CONTRACT_AUTH } from '../test-support/panel.mjs';

const gateEnvPt = async (t, options) => {
  const env = await gateEnv(t, options);
  await writeFile(join(env.dir, '.pi', 'pi-acceptance-gate.locale.json'), JSON.stringify({ uiLanguage: 'pt-BR' }));
  return env;
};

/**
 * The panel driven for real, through the `host` seam and the faithful fake. Every
 * driver here returns the promise the component returned, so persistence is awaited
 * on the write and never on a tick budget (rule 5): `cycle`, `pick` and the typed
 * input all hand back what `onChange` produced.
 */
test('bare /gate opens the panel, and closing it counts the changes and names the file', async (t) => {
  const env = await gateEnvPt(t, { contracts: { 'a.yaml': CONTRACT_ONE } });
  const { running } = await env.open();
  const s = env.settings();
  assert.ok(s, 'a SettingsList foi montada');
  assert.equal(s.find('autoSelect').currentValue, 'on', 'a auto-seleção anunciada é o default');
  assert.equal(
    s.find('scopeSource').currentValue,
    'available',
    'o escopo default é a capacidade da sessão',
  );
  assert.equal(s.find('maxAutoRevisions').currentValue, '2');

  const original = await env.file();
  await s.cycle('enabled', 'off');
  await s.cycle('ttl', '1h');
  assert.equal(await env.file(), original, 'editar no painel mantém o rascunho sem gravar');
  await env.f.ctx.lastScreen.handleInput('\u0013');
  s.onCancel();
  await running;
  const closed = env.f.ctx.customResult;
  assert.equal(closed.changed.length, 1, 'um Ctrl+S confirma o conjunto de mudanças');
  const summary = env.f.notifications.at(-1);
  assert.match(summary, /Gate · 1 mudança\(s\)/);
  assert.ok(
    summary.includes(join(env.dir, '.pi', 'pi-suite.yaml')),
    `o resumo final diz o caminho do arquivo escrito: ${summary}`,
  );
  const written = await env.saved();
  assert.equal(written.enabled, false);
  assert.equal(written.approvalTtlSeconds, 3600);
  await running;
});

test('the contract submenu decides, and navigateTo already opens the second level', async (t) => {
  const env = await gateEnvPt(t, {
    contracts: { 'a.yaml': CONTRACT_ONE, 'b.yaml': CONTRACT_AUTH },
  });
  const { running } = await env.open();
  const s = env.settings();
  s.open('contract');
  const picker = env.tui.created.select.at(-1);
  assert.match(picker.items[0].label, /^▸ recomendado /, 'o primeiro candidato vem marcado');
  assert.deepEqual(picker.items.map((i) => i.value).sort(), ['TASK-001', 'TASK-002']);

  await picker.pick('TASK-001');
  // `navigateTo` re-selects AND activates the target (`settings-list.js:222-233`), so
  // the second level is open by itself — pressing enter again would pick one of ITS rows.
  const checkers = s.top();
  assert.match(
    checkers.render(90).join('\n'),
    /tests · test · custo 5/,
    'o segundo nível mostra os checkers do contrato escolhido',
  );
  assert.equal(s.find('contract').currentValue, 'TASK-001');
  assert.equal(
    env.f.notifications.at(-1),
    'contrato → TASK-001 · escolha explícita (só esta sessão)',
    'a decisão diz o que mudou e que é da sessão',
  );
  assert.ok(!(await readFile(join(env.dir, '.pi', 'pi-suite.yaml'), 'utf8')).includes('TASK-001'), 'escolher contrato não escreve config');

  // Esc one level: back to the main list, the screen itself stays open.
  checkers.handleInput('\u001b');
  assert.ok(!env.f.ctx.customResult, 'o painel ainda está aberto');
  assert.equal(env.tui.created.settings.length, 1, 'nenhum painel recriado');

  s.onCancel();
  await running;
});

test('the arm submenu offers one-shot, TTL and project scope — and only the persistent ones write', async (t) => {
  const env = await gateEnvPt(t);
  const { running } = await env.open();
  const s = env.settings();
  s.open('arm');
  const arm = env.tui.created.select.at(-1);
  assert.deepEqual(arm.items.map((i) => i.value), ['once', 'ttl:15min', 'ttl:1h', 'ttl:8h', 'always']);
  assert.match(arm.items[0].label, /^▸ recomendado só esta verificação/);

  await arm.pick('once');
  assert.equal(await env.file(), 'acceptanceGate:\n  enabled: true\n  scope: { source: available, strict: true }\n', 'só esta verificação não toca no arquivo');
  assert.match(env.f.notifications.at(-1), /armado só para esta verificação · nada foi escrito/);

  s.open('arm');
  await env.tui.created.select.at(-1).pick('ttl:1h');
  const afterTtl = await env.saved();
  assert.equal(afterTtl.armScope, 'ttl');
  assert.equal(afterTtl.approvalTtlSeconds, 3600);
  assert.match(s.find('arm').currentValue, /armado até/, 'a linha diz que está armado e até quando');

  s.open('arm');
  await env.tui.created.select.at(-1).pick('always');
  const afterAlways = await env.saved();
  assert.equal(afterAlways.armScope, 'always');
  assert.equal(afterAlways.autoVerifyOnCandidate, true, 'sempre neste projeto liga a verificação automática');

  s.onCancel();
  await running;
});

test('widening an allowlist is two deliberate acts in the panel, and narrowing is one', async (t) => {
  const env = await gateEnvPt(t, {
    config: 'acceptanceGate:\n  allowedExecutables: [node]\n  allowedHosts: []\n',
  });
  const { running } = await env.open();
  const s = env.settings();
  s.open('allowedExecutables');
  const picker = env.tui.created.select.at(-1);
  assert.ok(picker.items.some((i) => i.value === 'add:mvn'), 'o painel oferece os candidatos da tabela');
  assert.ok(picker.items.some((i) => i.value === 'remove:node'));

  await picker.pick('add:mvn');
  const afterFirst = await env.file();
  assert.match(env.f.ctx.lastScreen.render(100).join('\n'), /NADA foi escrito/, 'a primeira escolha só explica o que faria');
  assert.equal(afterFirst.includes('mvn'), false, 'nada foi liberado ainda');

  s.open('allowedExecutables');
  await env.tui.created.select.at(-1).pick('add:mvn');
  assert.equal((await env.file()).includes('mvn'), false, 'a confirmação do widening ainda fica em rascunho');
  assert.match(s.find('allowedExecutables').currentValue, /2 liberado/);
  await env.f.ctx.lastScreen.handleInput('\u0013');
  assert.match((await env.file()), /mvn/, 'Ctrl+S confirma o widening aprovado em dois passos');

  s.open('allowedExecutables');
  await env.tui.created.select.at(-1).pick('remove:node');
  const afterRemove = await env.file();
  assert.match(afterRemove, /node/, 'estreitar também aguarda Ctrl+S');
  await env.f.ctx.lastScreen.handleInput('\u0013');
  const afterSave = await env.file();
  assert.ok(!/node/.test(afterSave.replace('acceptanceGate', '')), `node saiu depois de Ctrl+S: ${afterSave}`);

  s.onCancel();
  await running;
});

test('creating a contract by typing writes .pi/tasks/<ID>.yaml and the decision announces it', async (t) => {
  const env = await gateEnvPt(t, { contracts: {} });
  const { running } = await env.open();
  const s = env.settings();
  assert.equal(s.find('contract').currentValue, 'nenhum', 'sem contrato o painel diz nenhum, não o primeiro alfabetico');
  s.open('create');
  const screen = s.top();
  for (const ch of 'TASK-007') screen.handleInput(ch);
  await screen.handleInput('\r');
  const written = await readFile(join(env.dir, '.pi', 'tasks', 'TASK-007.yaml'), 'utf8');
  assert.match(written, /id: "?TASK-007"?/);
  assert.match(written, /type: git_diff/, 'o checker mais barato vem primeiro');
  assert.match(screen.render(90).join('\n'), /salvo em .*TASK-007\.yaml/);
  assert.equal(s.find('contract').currentValue, 'TASK-007', 'a criação vira a decisão da sessão');
  s.onCancel();
  await running;
});

test('Esc cancels a pending contract creation and the dashboard remains usable', async (t) => {
  const env = await gateEnvPt(t, { contracts: {} });
  const { running } = await env.open();
  const s = env.settings();
  const original = await env.file();
  s.open('create');
  const createScreen = s.top();
  for (const ch of 'TASK-008') createScreen.handleInput(ch);
  const creating = createScreen.handleInput('\r');
  const canceling = createScreen.handleInput('\u001b');
  await Promise.all([creating, canceling]);

  await assert.rejects(readFile(join(env.dir, '.pi', 'tasks', 'TASK-008.yaml')), { code: 'ENOENT' });
  assert.equal(await env.file(), original, 'cancelar antes do commit não altera o projeto');
  assert.equal(env.f.ctx.customResult, undefined, 'cancelar a ação retorna ao painel');
  await s.cycle('enabled', 'off');
  assert.equal(await env.file(), original, 'o painel segue editável e mantém mudanças como rascunho');
  await env.f.ctx.lastScreen.handleInput('\u001b');
  assert.match(env.f.ctx.lastScreen.render(100).join('\n'), /Ctrl\+S salva; Esc novamente descarta/);
  await env.f.ctx.lastScreen.handleInput('\u001b');
  await running;
  assert.equal(env.f.ctx.customResult.discarded, true);
  assert.equal(await env.file(), original, 'o descarte também preserva a configuração salva');
});

test('report and help are readable text screens that esc leaves without closing the panel', async (t) => {
  const env = await gateEnvPt(t);
  const { running } = await env.open();
  const s = env.settings();
  assert.match(s.find('report').currentValue, /nada verificado/);
  s.open('report');
  assert.match(s.top().render(90).join('\n'), /Nenhuma verificação nesta sessão/);
  s.top().handleInput('\u001b');
  s.open('help');
  assert.match(s.top().render(90).join('\n'), /\/gate use TASK-ID/);
  s.top().handleInput('\u001b');
  assert.ok(!env.f.ctx.customResult, 'esc num submenu volta um nível sem fechar o painel');
  s.onCancel();
  const closed = env.f.ctx.customResult;
  assert.deepEqual(closed.changed, [], 'navegar não é mudar');
});
