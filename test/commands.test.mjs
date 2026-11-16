import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { gateEnv, CONTRACT_ONE, CONTRACT_AUTH, waitFor } from '../test-support/panel.mjs';

const SEED =
  'modelEconomist:\n  mode: rules\n  policy: economy\nloopGuard:\n  policy: balanced\nacceptanceGate:\n  enabled: true\n  maxAutoRevisions: 3\n';

const text = (env) => String(env.f.notifications.at(-1));

test('a valid value writes only its own section, and says it is already in effect', async (t) => {
  const env = await gateEnv(t, { config: SEED });
  const before = await env.file();
  await env.command('scope declared');
  const after = await env.file();
  const doc = (await import('yaml')).parse(after);
  assert.equal(doc.acceptanceGate.scope.source, 'declared');
  assert.equal(doc.modelEconomist.mode, 'rules', 'a seção de outra extensão ficou intacta');
  assert.equal(doc.loopGuard.policy, 'balanced');
  assert.match(text(env), /já em efeito/);
  assert.doesNotMatch(after + text(env), /\/reload/i);
  assert.notEqual(after, before, 'e o arquivo mudou de verdade');
  // Only the keys of this section moved: nothing else was rewritten wholesale.
  assert.ok(after.includes('maxAutoRevisions: 3'), 'um valor já existente da seção foi preservado');
});

test('an invalid value is refused with the options and writes nothing', async (t) => {
  const env = await gateEnv(t, { config: SEED });
  const before = await env.file();
  await assert.rejects(
    env.command('scope sometimes'),
    (e) => {
      assert.match(e.message, /Invalid scopeSource: sometimes/);
      assert.match(e.message, /Use: available \| declared/, 'citar as opções é o conserto');
      return true;
    },
  );
  assert.equal(await env.file(), before, 'recusado antes de escrever — nenhum byte mudou');
  await assert.rejects(env.command('ttl 2h'), (e) => {
    assert.match(e.message, /Use: 15min \| 1h \| 8h/);
    return true;
  });
  await assert.rejects(env.command('revisions 99'), /Use: 0 \| 1 \| 2 \| 3/);
  assert.equal(await env.file(), before);
});

test('status names the contract and why it was chosen', async (t) => {
  const env = await gateEnv(t, { contracts: { 'a.yaml': CONTRACT_ONE } });
  await env.command('status');
  assert.match(text(env), /contrato: TASK-001 · único contrato do projeto, selecionado automaticamente/);
  assert.match(
    text(env),
    /continuações: 1 \(pedido 2, teto global 1\)|continuações: 1/,
    'o clamp aparece, não fica escondido numa closure',
  );
});

test('with two contracts the decision follows the files that changed, and the contract in force blocks what it forbids', async (t) => {
  const env = await gateEnv(t, {
    contracts: { 'a.yaml': CONTRACT_ONE, 'b.yaml': CONTRACT_AUTH },
    config: SEED,
  });
  // No evidence yet: nothing is silently picked when the ranking is a tie.
  await env.command('status');
  assert.match(text(env), /TASK-00|contrato: /);
  env.f.ctx.ui.select = async (title, options) => {
    assert.match(title, /contratos em \.pi\/tasks/);
    assert.match(options[0], /^▸ recomendado /);
    return options[0];
  };
  await env.command('use TASK-002');
  await env.command('status');
  assert.match(text(env), /contrato: TASK-002 · escolha explícita: \/gate use TASK-002/);
  // The decision is applied, not decorative: the contract forbids src/legacy.
  const blocked = await env.f.emit('tool_call', {
    toolName: 'edit',
    toolCallId: 'c1',
    input: { path: 'src/legacy/old.ts' },
  });
  assert.equal(blocked.block, true, 'o contrato selecionado manda na sessão');
  const allowed = await env.f.emit('tool_call', {
    toolName: 'edit',
    toolCallId: 'c2',
    input: { path: 'src/auth/login.ts' },
  });
  assert.ok(!allowed, 'dentro do permitido nada é bloqueado');
});

test('autoSelect: false turns the announcement into a question the gate will not answer alone', async (t) => {
  const env = await gateEnv(t, {
    contracts: { 'a.yaml': CONTRACT_ONE, 'b.yaml': CONTRACT_AUTH },
    config: 'acceptanceGate:\n  autoSelect: false\n',
  });
  await env.command('status');
  assert.match(text(env), /contrato: nenhum · autoSelect está off/);
  await assert.rejects(env.command('check'), /Nenhum contrato selecionado|Auto-selection/);
  await env.command('auto-select on');
  assert.equal((await env.saved()).autoSelect, true);
  await env.command('status');
  assert.match(text(env), /contrato: TASK-00\d/);
});

test('deny narrows immediately and says where it was written', async (t) => {
  const env = await gateEnv(t, { config: 'acceptanceGate:\n  allowedExecutables: [node, mvn]\n' });
  env.f.ctx.ui.confirm = async () => true;
  await env.command('deny exe mvn');
  assert.match(text(env), /mvn saiu da allowlist · salvo em .*pi-suite\.yaml/);
  assert.ok(!(await env.file()).includes('mvn'));
});

test('an unknown subcommand answers with the grammar it just broke', async (t) => {
  const env = await gateEnv(t);
  await assert.rejects(env.command('teleport now'), (e) => {
    assert.match(e.message, /Unknown \/gate teleport/);
    assert.match(e.message, /\/gate status/);
    return true;
  });
});

test('a changed file moves the ranking without anybody asking', async (t) => {
  const env = await gateEnv(t, {
    contracts: { 'a.yaml': CONTRACT_ONE, 'b.yaml': CONTRACT_AUTH },
  });
  await mkdir(join(env.dir, 'src', 'auth'), { recursive: true });
  await writeFile(join(env.dir, 'src', 'auth', 'login.ts'), 'x');
  // The cache is keyed on the session leaf, so a new turn re-reads `git status`.
  env.f.ctx.sessionManager.getLeafId = () => 'leaf-2';
  await env.command('status');
  assert.match(text(env), /contrato: TASK-002 · aderência aos \d+ arquivo\(s\) alterados: allowed-hits:1/);
});

test('Esc while entering the quick contract id or risk cancels without a fallback write', async (t) => {
  for (const cancelled of [undefined, '']) {
    const idCancelled = await gateEnv(t, { contracts: {} });
    idCancelled.f.ctx.ui.confirm = async () => true;
    idCancelled.f.ctx.ui.input = async () => cancelled;
    await idCancelled.command('check');
    assert.deepEqual(await readdir(join(idCancelled.dir, '.pi', 'tasks')), []);
    assert.match(String(idCancelled.f.notifications.at(-1)), /criação cancelada/);

    const riskCancelled = await gateEnv(t, { contracts: {} });
    riskCancelled.f.ctx.ui.confirm = async () => true;
    riskCancelled.f.ctx.ui.input = async () => 'TASK-999';
    riskCancelled.f.ctx.ui.select = async () => cancelled;
    await riskCancelled.command('check');
    assert.deepEqual(await readdir(join(riskCancelled.dir, '.pi', 'tasks')), []);
    assert.match(String(riskCancelled.f.notifications.at(-1)), /criação cancelada/);
  }
});
