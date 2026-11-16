import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LANGUAGE_FILE,
  MESSAGE_KEYS,
  catalogParity,
  languageName,
  loadProjectLanguage,
  saveProjectLanguage,
  translate,
} from '../lib/i18n.mjs';
import { gateEnv } from '../test-support/panel.mjs';
import { panelItems } from '../menu.mjs';

const RUN = 'ct55-pi-acceptance-gate-20261025-01';

test('English and Brazilian Portuguese catalogs have matching keys and placeholders', () => {
  assert.deepEqual(catalogParity(), { keys: true, placeholders: true });
  assert.ok(MESSAGE_KEYS.length >= 100, `expected a stable catalog, got ${MESSAGE_KEYS.length} keys`);
  for (const key of MESSAGE_KEYS) {
    assert.ok(translate('en', key).text.length > 0, `${key} has English text`);
    assert.ok(translate('pt-BR', key).text.length > 0, `${key} has Portuguese text`);
  }
  assert.equal(languageName('en'), 'English');
  assert.equal(languageName('pt-BR'), 'Português (Brasil)');
  assert.deepEqual(translate('en', 'missing.catalog.key'), { text: 'Message unavailable in English.', usedFallback: true });
  assert.equal(panelItems({ conf: {}, state: {}, language: 'en', languageEnabled: false }).some((row) => row.id === 'uiLanguage'), false);
});

test('the first dashboard is English and exposes a per-project language row', async (t) => {
  const env = await gateEnv(t);
  const { running } = await env.open();
  const settings = env.settings();
  const language = settings.find('uiLanguage');
  assert.ok(language, 'trusted projects can choose a language');
  assert.equal(language.label, 'Language');
  assert.equal(language.currentValue, 'English');
  assert.deepEqual(language.values, ['en', 'pt-BR']);
  for (const row of settings.items) {
    const copy = `${row.label} ${row.currentValue} ${row.description ?? ''}`;
    assert.doesNotMatch(copy, /Message unavailable in English\./, `${row.id} has a complete English fallback`);
    assert.doesNotMatch(copy, /\b(?:não|contrato|verificação|escopo|salvar|salvo|fora|obrigatório|pendente|nada|sempre|projeto|candidata|rodada|sessão|idioma|armado|liberado)\b/i, `${row.id} does not mix Portuguese into English`);
  }
  for (const width of [40, 80, 120]) {
    const rendered = env.f.ctx.lastScreen.render(width).join('\n');
    assert.match(rendered, /Gate · ON · contract/);
    if (width === 40) {
      assert.match(rendered, /Automatic contr…/);
      assert.match(rendered, /10 allowed/);
    } else {
      assert.match(rendered, /Automatic contract selection/);
    }
    assert.match(rendered, /Language = English/);
    assert.match(rendered, /Ctrl\+S/);
    assert.doesNotMatch(rendered, /Auto-seleção do contrato|Gate ativo|\uFFFD/);
  }
  await env.f.ctx.lastScreen.handleInput('\u001b');
  await running;
  await assert.rejects(readFile(join(env.dir, LANGUAGE_FILE)), { code: 'ENOENT' });
});

test('English submenus preserve command IDs and translate selection, checker, report, and help text', async (t) => {
  const env = await gateEnv(t);
  const { running } = await env.open();
  const settings = env.settings();
  const assertEnglish = (value, label) => {
    assert.doesNotMatch(value, /Message unavailable in English\./, `${label} has no missing-message fallback`);
    assert.doesNotMatch(value, /\b(?:não|contrato|verificação|escopo|salvar|salvo|fora|obrigatório|pendente|nada|sempre|projeto|candidata|rodada|sessão|idioma|armado|liberado|recomendado|por)\b/i, `${label} has no Portuguese fragments`);
  };

  settings.open('checkers');
  const checkerScreen = settings.top();
  let text = checkerScreen.render(80).join('\n');
  assertEnglish(text, 'checker screen');
  assert.match(text, /cost 5/);
  assert.match(text, /command: node --test/);
  checkerScreen.handleInput('\u001b');

  settings.open('report');
  text = settings.top().render(80).join('\n');
  assertEnglish(text, 'report screen');
  assert.match(text, /No verification in this session/);
  settings.top().handleInput('\u001b');

  settings.open('help');
  text = settings.top().render(100).join('\n');
  assertEnglish(text, 'help screen');
  assert.match(text, /\/gate use TASK-ID/);
  settings.top().handleInput('\u001b');

  settings.open('contract');
  const contractItems = env.tui.created.select.at(-1).items;
  assertEnglish(contractItems.map((item) => `${item.label} ${item.description}`).join('\n'), 'contract picker');
  assert.ok(contractItems.every((item) => item.value === item.value.toUpperCase()), 'command IDs are not translated');
  await env.tui.created.select.at(-1).pick('TASK-001');
  assertEnglish(env.f.notifications.at(-1), 'contract selection notice');

  settings.open('arm');
  const armItems = env.tui.created.select.at(-1).items;
  assertEnglish(armItems.map((item) => `${item.label} ${item.description}`).join('\n'), 'arm picker');
  assert.deepEqual(armItems.map((item) => item.value), ['once', 'ttl:15min', 'ttl:1h', 'ttl:8h', 'always']);
  await env.tui.created.select.at(-1).pick('once');
  assertEnglish(env.f.notifications.at(-1), 'one-shot arm notice');

  settings.open('allowedExecutables');
  const executableItems = env.tui.created.select.at(-1).items;
  assertEnglish(executableItems.map((item) => `${item.label} ${item.description}`).join('\n'), 'executable picker');
  assert.ok(executableItems.some((item) => item.value === 'remove:mvn'), 'backend values remain stable');
  env.tui.created.select.at(-1).cancel();

  settings.open('allowedExecutables');
  await env.tui.created.select.at(-1).pick('add:npx');
  assertEnglish(env.f.ctx.lastScreen.render(80).join('\n'), 'security widening confirmation');

  settings.open('create');
  text = settings.top().render(80).join('\n');
  assertEnglish(text, 'create screen');
  assert.equal(env.tui.created.input.at(-1).placeholder, 'e.g. TASK-002');
  settings.top().handleInput('\u001b');

  settings.onCancel();
  await running;
  assertEnglish(env.f.notifications.at(-1), 'dashboard completion summary');
});

test('language changes preview immediately, save on Ctrl+S, and Esc discards a later draft', async (t) => {
  const env = await gateEnv(t);
  const { running } = await env.open();
  const settings = env.settings();
  const localePath = join(env.dir, LANGUAGE_FILE);

  await settings.cycle('uiLanguage', 'pt-BR');
  let rendered = env.f.ctx.lastScreen.render(80).join('\n');
  assert.match(rendered, /Idioma = Português \(Brasil\)/);
  assert.match(rendered, /Auto-seleção do contrato/);
  assert.match(rendered, /Rascunho do idioma/);
  await assert.rejects(readFile(localePath), { code: 'ENOENT' });

  await env.f.ctx.lastScreen.handleInput('\u0013');
  assert.deepEqual(JSON.parse(await readFile(localePath, 'utf8')), { uiLanguage: 'pt-BR' });
  assert.match(env.f.ctx.lastScreen.render(80).join('\n'), /Idioma = Português/);

  await settings.cycle('uiLanguage', 'en');
  rendered = env.f.ctx.lastScreen.render(80).join('\n');
  assert.match(rendered, /Language = English/);
  assert.match(rendered, /Automatic contract selection/);
  assert.deepEqual(JSON.parse(await readFile(localePath, 'utf8')), { uiLanguage: 'pt-BR' });
  await env.f.ctx.lastScreen.handleInput('\u001b');
  await env.f.ctx.lastScreen.handleInput('\u001b');
  await running;
  assert.equal(env.f.ctx.customResult.discarded, true);
  assert.deepEqual(JSON.parse(await readFile(localePath, 'utf8')), { uiLanguage: 'pt-BR' });

  env.f.ctx.lastScreen = null;
  const secondSession = await env.open();
  const secondSettings = env.tui.created.settings.at(-1);
  assert.equal(secondSettings.find('uiLanguage').currentValue, 'Português (Brasil)');
  await secondSettings.cycle('uiLanguage', 'en');
  await env.f.ctx.lastScreen.handleInput('\u0013');
  assert.deepEqual(JSON.parse(await readFile(localePath, 'utf8')), { uiLanguage: 'en' });
  secondSettings.onCancel();
  await secondSession.running;
});

test('project locale is trusted-project-only and invalid files are never overwritten', async (t) => {
  const root = await mkdtemp(join(tmpdir(), `${RUN}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.pi'), { recursive: true });
  const path = join(root, LANGUAGE_FILE);
  await writeFile(path, JSON.stringify({ uiLanguage: 'pt-BR' }));

  assert.deepEqual(await loadProjectLanguage(root, false), { language: 'en' });
  await assert.rejects(saveProjectLanguage(root, false, 'en'), { message: 'project-not-trusted' });
  assert.deepEqual(await loadProjectLanguage(root, true), { language: 'pt-BR' });

  const invalid = '{not json';
  await writeFile(path, invalid);
  assert.deepEqual(await loadProjectLanguage(root, true), { language: 'en', warning: 'invalid' });
  await assert.rejects(saveProjectLanguage(root, true, 'pt-BR'));
  assert.equal(await readFile(path, 'utf8'), invalid);

  const unknown = JSON.stringify({ uiLanguage: 'en', global: true });
  await writeFile(path, unknown);
  await assert.rejects(saveProjectLanguage(root, true, 'pt-BR'), { message: 'unknown-project-locale-field' });
  assert.equal(await readFile(path, 'utf8'), unknown);
});

test('a failed locale save keeps the selected language draft visible and leaves invalid bytes untouched', async (t) => {
  const env = await gateEnv(t);
  const localePath = join(env.dir, LANGUAGE_FILE);
  const invalid = '{bad locale';
  await writeFile(localePath, invalid);
  const { running } = await env.open();
  assert.match(env.f.notifications.join('\n'), /Invalid project language; using English/);
  await env.settings().cycle('uiLanguage', 'pt-BR');
  await env.f.ctx.lastScreen.handleInput('\u0013');
  assert.match(env.f.ctx.lastScreen.render(80).join('\n'), /Falha ao salvar:/);
  assert.equal(env.settings().find('uiLanguage').currentValue, 'Português (Brasil)');
  assert.equal(await readFile(localePath, 'utf8'), invalid);
  await env.f.ctx.lastScreen.handleInput('\u001b');
  assert.match(env.f.ctx.lastScreen.render(80).join('\n'), /Alterações não salvas/);
  await env.f.ctx.lastScreen.handleInput('\u001b');
  await running;
  assert.equal(await readFile(localePath, 'utf8'), invalid);
});

test('a project locale persists independently and missing preference defaults to English', async (t) => {
  const root = await mkdtemp(join(tmpdir(), `${RUN}-`));
  const otherRoot = await mkdtemp(join(tmpdir(), `${RUN}-`));
  t.after(async () => {
    await Promise.all([rm(root, { recursive: true, force: true }), rm(otherRoot, { recursive: true, force: true })]);
  });
  await mkdir(join(root, '.pi'), { recursive: true });
  await mkdir(join(otherRoot, '.pi'), { recursive: true });
  assert.deepEqual(await loadProjectLanguage(root, true), { language: 'en' });
  assert.deepEqual(await loadProjectLanguage(otherRoot, true), { language: 'en' });
  await saveProjectLanguage(root, true, 'pt-BR');
  assert.deepEqual(await loadProjectLanguage(root, true), { language: 'pt-BR' });
  assert.deepEqual(await loadProjectLanguage(otherRoot, true), { language: 'en' });
  await saveProjectLanguage(root, true, 'en');
  assert.deepEqual(await loadProjectLanguage(root, true), { language: 'en' });
});
