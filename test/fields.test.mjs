import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { FIELDS, fieldValues, applyField, enumItems, listItems, panelItems, armRows, c0 } from '../menu.mjs';
import { gateDefaults, validate } from '../gate.mjs';
import { TTL_CHOICES, ARM_ACTIONS, armAction } from '../select.mjs';
import { validateConfig, merge } from '../lib/core.mjs';

/** The keys `acceptanceGate` is allowed to have — taken from the shipped defaults. */
const SECTION_KEYS = new Set(Object.keys(gateDefaults.acceptanceGate));
const NESTED_KEYS = { scope: new Set(Object.keys(gateDefaults.acceptanceGate.scope)) };
/**
 * `lock` is a *config* key, and two fields may share one (the economist proved that
 * lock granularity matters: `scope` gates both the source and the strict flag). What
 * must never happen is a lock naming a key the section does not have — that is a knob
 * no global policy can ever lock, so the guard is decoration.
 */
const LOCK_KEYS = new Set([
  ...SECTION_KEYS,
  ...Object.keys(gateDefaults.acceptanceGate.scope),
]);

/** What a written patch is supposed to leave in the file, read from the config shape.
 * Written by hand on purpose: if `patch` and the config disagree, this test is the one
 * that says so (it is the `selected-as` bug from the economist, generically). */
const readBack = (id, c) =>
  ({
    enabled: c.enabled ? 'on' : 'off',
    autoSelect: c.autoSelect === false ? 'off' : 'on',
    autoVerify: c.autoVerifyOnCandidate ? 'on' : 'off',
    continuePending: c.continueForPendingChecks ? 'on' : 'off',
    maxAutoRevisions: String(c.maxAutoRevisions),
    armScope: c.armScope,
    ttl: TTL_CHOICES.find((t) => t.seconds === c.approvalTtlSeconds)?.value,
    scopeSource: c.scope?.source,
    scopeStrict: c.scope?.strict === false ? 'off' : 'on',
    allowedExecutables: (c.allowedExecutables ?? []).join(','),
    allowedHosts: (c.allowedHosts ?? []).join(','),
  })[id];

test('the table is the only source: every field has values, a real lock and a valid patch', () => {
  const ids = Object.keys(FIELDS);
  assert.ok(ids.length >= 9, `esperava pelo menos 9 campos, achei ${ids.length}`);
  for (const id of ids) {
    const field = FIELDS[id];
    assert.equal(typeof field.patch, 'function', `${id}.patch`);
    assert.equal(typeof field.note, 'function', `${id}.note`);
    assert.equal(typeof field.current, 'function', `${id}.current`);
    assert.ok(LOCK_KEYS.has(field.lock), `${id}.lock aponta para chave inexistente: ${field.lock}`);
    const values = fieldValues(id, c0(), { contractHosts: ['api.example.com'] });
    assert.ok(Array.isArray(values), `${id}.values não é lista`);
    if (field.kind !== 'list')
      assert.ok(values.length, `${id}: values vazia — o painel não teria o que oferecer`);
    for (const value of values) {
      const { patch } = applyField(c0(), id, value, { state: { contractHosts: ['api.example.com'] } });
      for (const key of Object.keys(patch))
        assert.ok(SECTION_KEYS.has(key), `${id}: patch escreve chave fora da seção: ${key}`);
      for (const [key, sub] of Object.entries(patch))
        if (NESTED_KEYS[key])
          for (const nested of Object.keys(sub))
            assert.ok(
              NESTED_KEYS[key].has(nested),
              `${id}: patch escreve ${key}.${nested}, que não existe na seção`,
            );
      // The patch has to survive the same validator the writer runs before landing.
      const next = merge(c0(), patch);
      validateConfig({ acceptanceGate: next });
      if (field.kind === 'list') {
        // A list field is an action on membership, not a scalar: `add:mvn` must leave
        // `mvn` in the file and `remove:mvn` must take it out.
        const [op, target] = String(value).split(':');
        assert.equal(
          (next[field.listKey] ?? []).includes(target),
          op === 'add',
          `${id}: ofereceu ${value} e o arquivo não reflete isso`,
        );
      } else
        assert.equal(
          readBack(id, next),
          value,
          `${id}: ofereceu ${value} e o arquivo não volta esse valor`,
        );
    }
    // The declared default of every enum row must be one of its own values, or the
    // panel opens on a row whose value the table refuses.
    if (field.kind !== 'list')
      assert.ok(
        values.includes(field.current(c0())),
        `${id}: current() devolve ${field.current(c0())}, que não está em values`,
      );
  }
});

test('every enum row the panel shows is exactly a table field, in table order', () => {
  const rows = enumItems({ conf: c0() });
  const expected = Object.keys(FIELDS).filter((id) => FIELDS[id].kind !== 'list');
  assert.deepEqual(rows.map((r) => r.id), expected);
  for (const row of rows)
    assert.deepEqual(
      row.values,
      fieldValues(row.id, c0()),
      `${row.id}: a linha tem uma lista de valores própria — foi assim que o painel do economist ofereceu um valor que a tabela recusava`,
    );
  assert.deepEqual(
    listItems(c0(), { state: { contractHosts: ['api.example.com'] } }).map((r) => r.id),
    Object.keys(FIELDS).filter((id) => FIELDS[id].kind === 'list'),
  );
});

test('a value the table refuses is refused by both paths, before anything is written', () => {
  for (const id of ['scopeSource', 'armScope', 'ttl', 'maxAutoRevisions']) {
    assert.throws(
      () => applyField(c0(), id, 'not-a-value'),
      (e) => /Invalid/.test(e.message) && /Use: /.test(e.message),
      `${id} aceitou um valor fora da tabela`,
    );
  }
  assert.throws(() => applyField(c0(), 'nao-existe', 'on'), /campo desconhecido/);
});

test('a locked key blocks the table, not the label, and the row disappears from the panel', () => {
  const locked = { maxAutoRevisions: 1, scope: 'available' };
  assert.throws(
    () => applyField(c0(), 'maxAutoRevisions', '2', { locked }),
    /travado por política global/,
  );
  // `scope` locks two rows at once: the source and the strict flag share the key.
  assert.throws(() => applyField(c0(), 'scopeStrict', 'off', { locked }), /travado/);
  const rows = panelItems({ conf: c0(), locked, state: {} });
  assert.ok(!rows.some((r) => r.id === 'maxAutoRevisions'));
  assert.ok(!rows.some((r) => r.id === 'scopeSource'));
  assert.ok(rows.some((r) => r.id === 'enabled'));
});

test('the arm submenu offers only values the table writes', () => {
  const rows = armRows(c0(), {});
  assert.deepEqual(rows.map((r) => r.value), ARM_ACTIONS.map((a) => a.value));
  assert.match(rows[0].label, /^▸ recomendado/, 'a recomendação vem marcada na primeira linha');
  // `once` writes nothing; a TTL row writes exactly the two fields that persist it;
  // and neither field accepts the other's values — one table, two columns.
  const ttl = applyField(c0(), 'ttl', '1h');
  assert.deepEqual(ttl.patch, { approvalTtlSeconds: 3600 });
  const scope = applyField(c0(), 'armScope', 'always');
  assert.deepEqual(scope.patch, { armScope: 'always' });
  assert.throws(() => applyField(c0(), 'armScope', '1h'), /Invalid armScope/);
  assert.throws(() => applyField(c0(), 'ttl', 'once'), /Invalid ttl/);
  assert.equal(armAction('1h').value, 'ttl:1h', '/gate arm 1h é a mesma linha do painel');
  assert.equal(armAction('ttl').seconds, 900, 'a janela é a que já está no arquivo');
  assert.equal(armAction('forever'), null);
});

test('validateConfig knows the new fields and tolerates another extension section', () => {
  assert.throws(() => validateConfig({ acceptanceGate: { scope: { source: 'sometimes' } } }), /scope source/);
  assert.throws(() => validateConfig({ acceptanceGate: { scope: { strict: 'yes' } } }), /strict flag/);
  assert.throws(() => validateConfig({ acceptanceGate: { armScope: 'forever' } }), /arm scope/);
  assert.throws(() => validateConfig({ acceptanceGate: { autoSelect: 'sim' } }), /boolean policy/);
  assert.throws(() => validateConfig({ acceptanceGate: { approvalTtlSeconds: 0 } }), /approvalTtlSeconds/);
  assert.throws(() => validateConfig({ acceptanceGate: { allowedExecutables: 'node' } }), /allowedExecutables/);
  assert.doesNotThrow(() =>
    validateConfig({
      acceptanceGate: { autoSelect: false, armScope: 'once', scope: { source: 'declared', strict: false } },
      loopGuard: { policy: 'strict' },
      someOtherExtension: { whatever: true },
    }),
  );
  // And a contract built from the defaults still validates as a contract.
  assert.equal(validate({ task: { id: 'A', acceptance: [{ id: 'd', type: 'git_diff' }] } }).id, 'A');
});
