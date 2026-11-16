import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const clients = ['.agents/skills', '.cursor/skills'];
const read = (path) => readFileSync(path, 'utf8');

test('Pi Acceptance Gate specialization is versioned and identical across clients', () => {
  const skills = clients.map((root) => read(`${root}/pi-acceptance-gate/SKILL.md`));
  const metadata = clients.map((root) => read(`${root}/pi-acceptance-gate/metadata.yaml`));
  assert.ok(skills[0].length > 0);
  assert.ok(skills.every((copy) => copy === skills[0]));
  assert.ok(metadata.every((copy) => copy === metadata[0]));
  for (const field of ['id: pi-acceptance-gate', 'version: 1.0.0', 'owner: pi-acceptance-gate', 'scope: "product-local; Codex, Pi and Cursor"']) {
    assert.ok(metadata[0].includes(field), field);
  }
});

test('AGENTS keeps product context outside the managed block and preserves the harness block', () => {
  const agents = read('AGENTS.md');
  const productStart = agents.indexOf('# Pi Acceptance Gate');
  const harnessStart = agents.indexOf('<!-- harness:start -->');
  const harnessEnd = agents.indexOf('<!-- harness:end -->');
  assert.ok(productStart >= 0 && harnessStart > productStart && harnessEnd > harnessStart);
  const productContext = agents.slice(productStart, harnessStart);
  for (const text of ['.agents/skills/pi-acceptance-gate/SKILL.md', '`/gate`', '`/acceptance`', 'definitionOfDone']) {
    assert.ok(productContext.includes(text), text);
  }
});

test('specialization reflects the shipped commands, contract field and explicit UI-save flow', () => {
  const packageJson = JSON.parse(read('package.json'));
  const extension = read('extension.mjs');
  const gate = read('gate.mjs');
  const menu = read('menu.mjs');
  const skill = read('.agents/skills/pi-acceptance-gate/SKILL.md');
  assert.equal(packageJson.scripts.test, 'node --test');
  assert.equal(packageJson.scripts.smoke, 'node scripts/smoke-panel.mjs');
  assert.equal(packageJson.scripts['smoke:create'], 'node scripts/smoke-create.mjs');
  assert.ok(extension.includes("pi.registerCommand('gate'"));
  assert.ok(extension.includes("pi.registerCommand('acceptance'"));
  assert.ok(gate.includes('raw.definitionOfDone') && gate.includes('task.definitionOfDone'));
  assert.ok(menu.includes('saveDraft') && menu.includes('ctrl+s'));
  for (const text of ['Ctrl+S', 'justificativa humana', 'perfil temporário isolado', 'Não leia nem copie configuração']) {
    assert.ok(skill.includes(text), text);
  }
});