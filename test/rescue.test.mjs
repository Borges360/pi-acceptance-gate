import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gateEnv, waitFor } from '../test-support/panel.mjs';

/** A contract whose only required evidence needs a binary this project has not allowed. */
const NEEDS_MVN = `task:
  id: MVN-1
  title: Java build
  risk: moderate
  acceptance:
    - id: build
      type: build
      command: mvn verify
      required: true
`;

const stubConfirms = (f, answer) => {
  const calls = [];
  f.ctx.ui.confirm = async (title, detail) => {
    calls.push([title, detail]);
    return typeof answer === 'function' ? answer(calls.length, title) : answer;
  };
  // Only the widening question, so "run the checkers?" noise does not move the count.
  return { calls, widening: () => calls.filter(([title]) => /fora do escopo/.test(title)) };
};

test('a blocked executable is offered as a decision: named, recommended first, and it says what it costs', async (t) => {
  const env = await gateEnv(t, {
    contracts: { 'mvn.yaml': NEEDS_MVN },
    config: 'acceptanceGate:\n  allowedExecutables: [node]\n',
  });
  // The run itself is authorized; the widening is refused.
  const { widening } = stubConfirms(env.f, (_n, title) => !/fora do escopo/.test(title));
  await env.command('check');
  assert.equal(widening().length, 1, 'perguntou uma vez');
  assert.match(widening()[0][0], /fora do escopo/, 'a pergunta nomeia o que falta');
  assert.match(widening()[0][1], /mvn/, 'e nomeia o binário');
  assert.match(widening()[0][1], /widening de segurança/, 'e diz o que a autorização significa');
  const text = String(env.f.notifications.at(-1));
  assert.match(text, /exe-not-allowlisted:mvn/, 'o motivo real aparece');
  assert.match(text, /\/gate allow exe mvn/, 'a linha de conserto é o comando exato');
  assert.match(text, /recusado — não será perguntado de novo nesta sessão/);
  assert.ok(
    !(await readFile(join(env.dir, '.pi', 'pi-suite.yaml'), 'utf8')).includes('mvn'),
    'recusa não escreve nada',
  );

  await env.command('check');
  assert.equal(widening().length, 1, 'depois de recusar, não insiste na mesma sessão');
});

test('accepting the recommendation widens the project file, not the global one', async (t) => {
  const env = await gateEnv(t, {
    contracts: { 'mvn.yaml': NEEDS_MVN },
    config: 'acceptanceGate:\n  allowedExecutables: [node]\n',
    global: 'modelEconomist:\n  mode: rules\n',
  });
  stubConfirms(env.f, true);
  await env.command('check');
  const project = await readFile(join(env.dir, '.pi', 'pi-suite.yaml'), 'utf8');
  assert.match(project, /- mvn/, 'mvn entrou na allowlist do projeto');
  assert.ok(
    !(await env.file()).includes('modelEconomist'),
    'a escrita não tocou a seção de outra extensão no arquivo do projeto',
  );
  const global = await readFile(join(env.dir, 'state', 'config.yaml'), 'utf8');
  assert.ok(!global.includes('mvn'), 'o global não recebeu widening — um repo não decide os binários dos outros');
  assert.match(String(env.f.notifications.at(-1)), /▸ aplicado: mvn liberado/);
});

test('the advice names an uninstalled binary as itself, and never offers to invent it', async (t) => {
  const env = await gateEnv(t, {
    contracts: {
      'x.yaml': `task:
  id: GHOST-1
  title: Ghost
  risk: low
  acceptance:
    - id: ghost
      type: test
      command: gate-fixture-missing-exe run
      required: true
`,
    },
    config: 'acceptanceGate:\n  allowedExecutables: [node, gate-fixture-missing-exe]\n',
  });
  const { calls } = stubConfirms(env.f, true);
  await env.command('check');
  assert.equal(calls.length, 1, 'só a confirmação de rodar; nada a liberar');
  const text = String(env.f.notifications.at(-1));
  assert.match(text, /gate-fixture-missing-exe-not-installed/);
  assert.match(text, /instale gate-fixture-missing-exe/);
  assert.match(text, /scope declared/, 'e a alternativa de cobrar mesmo assim');
});

test('without a contract the error is a command to run, not a stack', async (t) => {
  const env = await gateEnv(t, { contracts: {} });
  env.f.ctx.hasUI = false;
  await assert.rejects(env.command(''), /\/gate init/);
  await assert.rejects(env.command('check'), /\/gate init|confie o projeto/);
});

test('bare /gate with no contracts asks, helps, and writes only what was accepted', async (t) => {
  const env = await gateEnv(t, { contracts: {} });
  const asks = [];
  env.f.ctx.ui.confirm = async (title, detail) => {
    asks.push([title, detail]);
    return true;
  };
  env.f.ctx.ui.input = async () => 'TASK-042';
  env.f.ctx.ui.select = async () => 'high';
  await env.command('check');
  assert.match(asks[0][0], /Nenhum contrato/, 'pergunta em vez de explodir');
  assert.match(asks[0][1], /mais baratos primeiro/, 'e explica o que vai sugerir');
  const written = await readFile(join(env.dir, '.pi', 'tasks', 'TASK-042.yaml'), 'utf8');
  assert.match(written, /id: TASK-042/);
  assert.match(written, /risk: high/, 'o risco escolhido vai para o arquivo');
  assert.match(written, /type: git_diff/, 'com o checker mais barato primeiro');
  assert.match(String(env.f.notifications.at(-1)), /salvo em .*TASK-042\.yaml/);
});

test('a refused creation is remembered: nothing is written and nothing is asked again', async (t) => {
  const env = await gateEnv(t, { contracts: {} });
  const asks = [];
  env.f.ctx.ui.confirm = async (title) => {
    asks.push(title);
    return false;
  };
  await env.command('check');
  assert.equal(asks.length, 1);
  await assert.rejects(
    () => readFile(join(env.dir, '.pi', 'tasks', 'TASK-042.yaml'), 'utf8'),
    /ENOENT/,
    'nenhum contrato foi criado',
  );
  await env.command('check');
  assert.equal(asks.length, 1, 'sem insistir depois de um não na mesma sessão');
  assert.match(String(env.f.notifications.at(-1)), /sem contrato o gate não verifica nada/);
});

test('a command that needs an approval says how to get one instead of just failing', async (t) => {
  const env = await gateEnv(t, { contracts: { 'mvn.yaml': NEEDS_MVN } });
  env.f.ctx.ui.confirm = async () => false;
  await assert.rejects(env.command('check'), /\/gate arm ttl/);
  await assert.rejects(env.command('arm not-a-scope'), /Invalid arm scope[\s\S]*once/);
  await assert.rejects(env.command('allow'), /\/gate allow exe\|host <valor>/);
});
