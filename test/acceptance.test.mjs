import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { fakePi } from '../test-support/fakes.mjs';
import gate from '../extension.mjs';
import { templates, recommend, validateAdvice, createAcceptance, advise } from '../acceptance.mjs';
import { loadTasks, verify, gateDefaults, validate } from '../gate.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'acceptance-create-'));
  const previous = process.env.PI_SUITE_HOME;
  process.env.PI_SUITE_HOME = join(root, 'state');
  execFileSync('git', ['init', root], { stdio: 'ignore' });
  const f = fakePi(root);
  const transcript = [],
    confirmations = [],
    events = [];
  const answers = [
    'Corrigir bug no menu de planos',
    'Abrir o menu e escolher status',
    'Resultado visível até voltar',
    'Preservar modo headless',
    'Reproduzir\nCorrigir\nValidar',
  ];
  f.ctx.ui.editor = async (title, prefill) => {
    transcript.push({ title, prefill });
    return answers.shift();
  };
  f.ctx.ui.input = async () => '';
  f.ctx.ui.select = async (title, choices) => {
    transcript.push({ title, choices });
    return choices[0];
  };
  f.ctx.ui.confirm = async (title, body) => {
    confirmations.push({ title, body });
    return true;
  };
  f.pi.events.on('suite:event', (e) => events.push(e));
  gate(f.pi);
  t.after(async () => {
    await f.emit('session_shutdown');
    if (previous === undefined) delete process.env.PI_SUITE_HOME;
    else process.env.PI_SUITE_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    f,
    answers,
    transcript,
    confirmations,
    events,
    create: () => f.command('acceptance', 'create'),
    files: () =>
      readdir(join(root, '.pi', 'tasks')).catch((e) =>
        e.code === 'ENOENT' ? [] : Promise.reject(e),
      ),
  };
}

test('bundled public templates and local decisions cover bugfix, feature, docs and custom', () => {
  assert.deepEqual(
    templates.map((t) => t.id),
    ['bugfix', 'feature', 'documentation', 'custom'],
  );
  assert.equal(recommend('corrigir bug').template, 'bugfix');
  assert.equal(recommend('nova feature').template, 'feature');
  assert.equal(recommend('atualizar documentação README').template, 'documentation');
  assert.equal(recommend('xyz').template, 'custom');
  assert.equal(recommend('fix auth production').risk, 'high');
});

test('/acceptance create writes a reviewed task and plan, selects it, and leaves acceptance unverified', async (t) => {
  const e = await setup(t);
  await e.create();
  const files = await e.files();
  assert.equal(files.length, 1);
  const document = parse(await readFile(join(e.root, '.pi', 'tasks', files[0]), 'utf8'));
  assert.equal(document.task.definitionOfDone.template, 'bugfix');
  assert.equal(document.task.definitionOfDone.answers.length, 3);
  assert.deepEqual(document.task.definitionOfDone.plan, ['Reproduzir', 'Corrigir', 'Validar']);
  assert.ok(e.transcript.some((v) => v.title.includes('Sugestão:')));
  assert.equal(e.confirmations.length, 1, 'only file creation was authorized');
  assert.match(e.confirmations[0].body, /Resultado visível/);
  const [task] = await loadTasks(e.root);
  assert.deepEqual(task.definitionOfDone, document.task.definitionOfDone);
  const result = await verify(task, e.root, true);
  assert.notEqual(result.status, 'accepted', 'answers and model text are not verification');
  assert.ok(result.receipts.every((r) => r.status === 'needs-human'));
  const context = await e.f.emit('before_agent_start');
  assert.match(context.message.content, /Resultado visível/);
  assert.match(context.message.content, /Reproduzir/);
  await e.f.command('acceptance', 'status');
  assert.match(String(e.f.notifications.at(-1)), /Nothing verified/);
  assert.ok(!e.events.some((x) => /verification_authorized|human_approved/.test(x.kind)));
  await e.f.command('acceptance', 'templates');
  assert.match(String(e.f.notifications.at(-1)), /Do zero/);
});

test('JEV automates template and risk decisions through the native classifier contract', async (t) => {
  const e = await setup(t);
  const classifier = { provider: 'typesafe', id: 'jev-latest', api: 'typesafe' };
  let requests = 0;
  e.f.ctx.modelRegistry.getModelsOfType = (type) => {
    assert.equal(type, 'classifier');
    return [classifier];
  };
  e.f.ctx.modelRegistry.classify = async (model, request, options) => {
    requests++;
    assert.equal(model, classifier);
    assert.match(request.state.objective, /bug/);
    assert.deepEqual(
      Object.keys(request.questions.template.criteria),
      templates.map((t) => t.id),
    );
    assert.ok(options.signal instanceof AbortSignal);
    return {
      stopReason: 'stop',
      answers: {
        template: { type: 'choice', choice: 'documentation' },
        risk: { type: 'choice', choice: 'high' },
      },
    };
  };
  e.f.ctx.ui.select = async (title, choices) => {
    if (title.includes('assistência'))
      return choices.find((c) => c.includes('Decisões automáticas'));
    if (title.includes('template sugerido')) assert.match(choices[0], /Documentação/);
    if (title.includes('risco sugerido')) assert.equal(choices[0], 'high');
    return choices[0];
  };
  await e.create();
  const [task] = await loadTasks(e.root);
  assert.equal(task.risk, 'high');
  assert.equal(task.definitionOfDone.template, 'documentation');
  assert.equal(task.definitionOfDone.assistant, 'typesafe/jev-latest');
  assert.equal(requests, 1);
});

test('an LLM supplies bounded questions, suggestions and a personalized plan without tools or executable policy', async (t) => {
  const e = await setup(t);
  e.f.ctx.modelRegistry.complete = async (_model, context, options) => {
    assert.equal(context.messages.length, 1, 'no transcript or repository contents are sent');
    assert.equal(context.tools, undefined);
    assert.equal(options.maxTokens, 1600);
    return {
      stopReason: 'stop',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            template: 'bugfix',
            risk: 'moderate',
            questions: [
              { question: 'O resultado fica visível?', suggestion: 'Teste status e show.' },
            ],
            steps: ['Corrigir foco do resultado', 'Validar navegação'],
          }),
        },
      ],
    };
  };
  Object.defineProperty(e.f.ctx, 'model', { get: () => ({ provider: 'local', id: 'small' }) });
  e.f.ctx.ui.select = async (title, choices) =>
    title.includes('assistência')
      ? choices.find((c) => c.includes('Perguntas personalizadas'))
      : choices[0];
  e.answers.splice(
    0,
    e.answers.length,
    'Corrigir bug no menu',
    'Sim, até pressionar Esc',
    'Corrigir foco do resultado\nValidar navegação',
  );
  await e.create();
  const [task] = await loadTasks(e.root);
  assert.equal(task.definitionOfDone.answers[0].question, 'O resultado fica visível?');
  assert.deepEqual(task.definitionOfDone.plan, ['Corrigir foco do resultado', 'Validar navegação']);
  assert.ok(e.transcript.some((v) => v.title.includes('Sugestão: Teste status e show.')));
  assert.ok(task.acceptance.every((c) => c.type === 'human_review'));
});

test('invalid or unavailable model replies fall back visibly; recommendations can be overridden to start from scratch', async (t) => {
  const e = await setup(t);
  e.f.ctx.modelRegistry.getModelsOfType = () => [{ provider: 'typesafe', id: 'jev' }];
  e.f.ctx.modelRegistry.classify = async () => ({
    stopReason: 'stop',
    answers: { template: { choice: '../../outside' }, risk: { choice: 'low' } },
  });
  e.f.ctx.ui.select = async (title, choices) =>
    title.includes('assistência')
      ? choices[1]
      : title.includes('template sugerido')
        ? choices.find((c) => c.includes('Do zero'))
        : choices[0];
  await e.create();
  assert.ok(e.f.notifications.some((v) => String(v).includes('Continuando com regras locais')));
  const [task] = await loadTasks(e.root);
  assert.equal(task.definitionOfDone.template, 'custom');
  assert.match(task.definitionOfDone.answers[0].question, /considerar pronto/);
  assert.equal(task.definitionOfDone.assistant, 'rules');
  assert.throws(() =>
    validateAdvice({ template: 'custom', risk: 'low', questions: Array(7).fill({}) }),
  );
  assert.throws(() => validateAdvice({ template: 'custom', risk: 'low', steps: [''] }));
});

test('every wizard dialog can be cancelled without creating a task', async (t) => {
  const e = await setup(t);
  // objective, mode, template, risk, 3 answers, command, plan, final review
  for (let cancelAt = 0; cancelAt < 10; cancelAt++) {
    let index = 0;
    e.f.ctx.ui.editor = async (_title, prefill) =>
      index++ === cancelAt ? undefined : (prefill ?? 'Resultado esperado');
    e.f.ctx.ui.select = async (_title, choices) => (index++ === cancelAt ? undefined : choices[0]);
    e.f.ctx.ui.input = async () => (index++ === cancelAt ? undefined : '');
    e.f.ctx.ui.confirm = async () => index++ !== cancelAt;
    await e.create();
    assert.deepEqual(await e.files(), [], `cancelled dialog ${cancelAt} wrote no contract`);
  }
});

test('untrusted, disabled and headless creation refuse before opening UI or writing files', async (t) => {
  const e = await setup(t);
  let opened = false;
  e.f.ctx.ui.editor = async () => {
    opened = true;
  };
  const options = { root: e.root, config: gateDefaults.acceptanceGate, selectTask: async () => {} };
  e.f.ctx.isProjectTrusted = () => false;
  await assert.rejects(createAcceptance(e.f.ctx, options), /Confie/);
  e.f.ctx.isProjectTrusted = () => true;
  await assert.rejects(
    createAcceptance(e.f.ctx, { ...options, config: { enabled: false } }),
    /desabilitado/,
  );
  e.f.ctx.hasUI = false;
  await assert.rejects(createAcceptance(e.f.ctx, options), /TUI\/RPC/);
  assert.equal(opened, false);
  assert.deepEqual(await e.files(), []);
});

test('explicit checker command is validated but never executed during creation; new tasks preserve previous contracts', async (t) => {
  const e = await setup(t);
  e.f.ctx.ui.input = async () => 'node --test';
  await e.create();
  const firstFiles = await e.files();
  const before = await readFile(join(e.root, '.pi', 'tasks', firstFiles[0]), 'utf8');
  const [task] = await loadTasks(e.root);
  assert.equal(task.acceptance[0].command, 'node --test');
  assert.equal(
    e.events.some((x) => x.kind === 'gate.evaluated'),
    false,
  );
  e.f.ctx.ui.editor = async (_title, prefill) => prefill ?? 'Outra tarefa';
  await e.create();
  assert.equal((await e.files()).length, 2);
  assert.equal(await readFile(join(e.root, '.pi', 'tasks', firstFiles[0]), 'utf8'), before);
  e.f.ctx.ui.input = async () => 'node --test; echo nope';
  await assert.rejects(e.create(), /shell interpolation/);
  assert.equal((await e.files()).length, 2);
});

test('definition metadata is bounded and older contracts remain compatible', () => {
  const task = { id: 'T', acceptance: [{ id: 'review', type: 'human_review' }] };
  assert.equal(validate(task).definitionOfDone, undefined);
  assert.throws(() => validate({ ...task, definitionOfDone: {} }), /definition of done/);
});

test('model requests obey session cancellation and never send known credentials', async () => {
  const controller = new AbortController();
  let sent;
  const ctx = {
    signal: controller.signal,
    modelRegistry: {
      classify: async (_model, request, options) => {
        sent = request;
        setTimeout(() => controller.abort(), 5);
        return new Promise((_, reject) =>
          options.signal.addEventListener('abort', () => reject(Error('aborted'))),
        );
      },
    },
  };
  await assert.rejects(
    advise(ctx, 'classifier', 'fix Bearer private-credential', { provider: 'local', id: 'jev' }),
  );
  assert.doesNotMatch(JSON.stringify(sent), /private-credential/);
  sent = undefined;
  await assert.rejects(advise(ctx, 'classifier', 'objective', {}), /cancelada/);
  assert.equal(sent, undefined, 'a cancelled session makes no additional request');
});

test('symlink task directories cannot redirect a reviewed task outside the project', async (t) => {
  const e = await setup(t);
  const outside = await mkdtemp(join(tmpdir(), 'acceptance-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(join(e.root, '.pi'), { recursive: true });
  await symlink(
    outside,
    join(e.root, '.pi', 'tasks'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(e.create(), /Symlink/);
  assert.deepEqual(await readdir(outside), []);
});
