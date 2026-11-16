import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { verify, gateDefaults, probeCacheClear } from '../gate.mjs';

/**
 * The gate scope: what this session can actually run. A missing executable, a host that
 * is not allowlisted and a checker that throws used to collapse into the same anonymous
 * `inconclusive`/`not-run`, so the only advice available was "the checker failed".
 *
 * The machine status stays untouched (CI exit codes read it); what changes is that the
 * reason is named and the display says `out-of-scope`. With `strict: true` — the default
 * — the verdict is identical to before, so no existing acceptance moves.
 */
const MISSING = 'gate-fixture-missing-exe';

const contract = (extra = {}) => ({
  id: 'SCOPE-1',
  risk: 'moderate',
  acceptance: [
    { id: 'cheap', type: 'git_diff', allowedPaths: ['**'], forbiddenPaths: ['secrets/**'] },
    { id: 'build', type: 'build', command: `${MISSING} verify`, required: true },
    ...(extra.more ?? []),
  ],
  ...extra,
});

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), 'gate-scope-'));
  execFileSync('git', ['init', dir], { stdio: 'ignore' });
  await writeFile(join(dir, 'a.txt'), 'x');
  probeCacheClear();
  return dir;
}

const config = (over = {}) =>
  ({ ...gateDefaults.acceptanceGate, ...over });

test('an executable that is not installed is named, not flattened into "inconclusive"', async (t) => {
  const dir = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const report = await verify(contract(), dir, true, false, {
    config: config({ allowedExecutables: [...gateDefaults.acceptanceGate.allowedExecutables, MISSING] }),
  });
  const receipt = report.receipts.find((r) => r.criterionId === 'build');
  assert.equal(receipt.status, 'not-run', 'a máquina ainda lê not-run');
  assert.equal(receipt.reasonCode, `${MISSING}-not-installed`, 'e o humano lê o motivo real');
  assert.equal(receipt.outOfScope, true);
  assert.equal(report.status, 'rejected', 'com strict on o veredito é o mesmo de antes');
  assert.match(report.reason, /not-installed|fora do escopo/, 'o motivo nomeia o binário');
  assert.equal(report.outOfScope.length, 1);
  assert.equal(report.scope.strict, true);
  // The cheap automatic checker still ran and passed: scope is per criterion.
  assert.equal(report.receipts.find((r) => r.criterionId === 'cheap').status, 'pass');
});

test('an executable outside the allowlist is a widening decision, not a failed test', async (t) => {
  const dir = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const report = await verify(contract(), dir, true, false, { config: config() });
  const receipt = report.receipts.find((r) => r.criterionId === 'build');
  assert.equal(receipt.reasonCode, `exe-not-allowlisted:${MISSING}`);
  assert.equal(receipt.error, receipt.reasonCode);
  assert.equal(receipt.outOfScope, true);
  assert.equal(report.status, 'rejected');
});

test('strict off lets an out-of-scope criterion leave the verdict — and says it was relaxed', async (t) => {
  const dir = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const report = await verify(contract(), dir, true, false, {
    config: config({
      allowedExecutables: [...gateDefaults.acceptanceGate.allowedExecutables, MISSING],
      scope: { source: 'available', strict: false },
    }),
  });
  assert.equal(report.status, 'accepted');
  assert.equal(report.scope.relaxed, true);
  assert.match(report.reason, /fora do escopo/);
});

test('scope: declared insists on every criterion and keeps the pre-0.3 reading', async (t) => {
  const dir = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const report = await verify(contract(), dir, true, false, {
    config: config({
      allowedExecutables: [...gateDefaults.acceptanceGate.allowedExecutables, MISSING],
      scope: { source: 'declared', strict: true },
    }),
  });
  const receipt = report.receipts.find((r) => r.criterionId === 'build');
  assert.equal(receipt.outOfScope, false, 'nada é re-rotulado: é o contrato cobrando o ambiente');
  assert.equal(receipt.status, 'not-run');
  assert.equal(report.status, 'rejected');
});

test('a host that is not allowlisted names the host, without reaching the network', async (t) => {
  const dir = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('{}', { status: 200 });
  };
  try {
    const report = await verify(
      contract({
        more: [{ id: 'health', type: 'api_contract', url: 'https://api.internal/health' }],
      }),
      dir,
      true,
      false,
      { config: config() },
    );
    const receipt = report.receipts.find((r) => r.criterionId === 'health');
    assert.equal(receipt.reasonCode, 'host-not-allowlisted:api.internal');
    assert.equal(receipt.outOfScope, true);
    assert.equal(calls, 0, 'nenhum fetch antes da allowlist');
  } finally {
    globalThis.fetch = original;
  }
});

test('a passing contract still passes: scope changes reasons, not acceptances', async (t) => {
  const dir = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const report = await verify(
    {
      id: 'OK-1',
      risk: 'low',
      acceptance: [
        { id: 'cheap', type: 'git_diff', allowedPaths: ['**'] },
        { id: 'tests', type: 'test', command: 'node -e "process.exit(0)"' },
      ],
    },
    dir,
    true,
    false,
    { config: config() },
  );
  assert.equal(report.status, 'accepted');
  assert.deepEqual(report.outOfScope, []);
  assert.equal(report.reason, null, 'sem bloqueio, sem motivo inventado');
});

test('a checker that throws keeps its own message, prefixed with the kind of failure', async (t) => {
  const dir = await repo();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const report = await verify(
    { id: 'ERR-1', risk: 'low', acceptance: [{ id: 'coverage', type: 'coverage', command: 'node -e "process.exit(0)"', reportPath: 'nope.json' }] },
    dir,
    true,
    false,
    { config: config() },
  );
  const receipt = report.receipts[0];
  assert.equal(receipt.status, 'inconclusive');
  assert.equal(receipt.reasonCode, 'artifact-missing', 'o artefato falta — isto não é capacidade ausente');
  assert.ok(!receipt.outOfScope, 'e por isso não sai do escopo');
  assert.equal(report.status, 'rejected');
});
