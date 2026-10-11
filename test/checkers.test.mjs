import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { verify, checkers, gateDefaults } from '../gate.mjs';
test('coverage must be fresh, generated artifacts do not stale the code snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-coverage-'));
  try {
    execFileSync('git', ['init', dir], { stdio: 'ignore' });
    await mkdir(join(dir, 'coverage'));
    await writeFile(
      join(dir, 'coverage', 'coverage-summary.json'),
      JSON.stringify({ total: { lines: { pct: 100 } } }),
    );
    await writeFile(
      join(dir, 'writer.mjs'),
      "import{writeFileSync}from'node:fs';writeFileSync('coverage/coverage-summary.json',JSON.stringify({total:{lines:{pct:90}}}));",
    );
    const task = {
      id: 'T',
      acceptance: [
        {
          id: 'coverage',
          type: 'coverage',
          command: ['node', 'writer.mjs'],
          reportPath: 'coverage/coverage-summary.json',
          thresholds: { lines: 80 },
        },
      ],
    };
    const result = await verify(task, dir, true);
    assert.equal(result.status, 'accepted');
    assert.equal(result.receipts[0].status, 'pass');
    task.acceptance[0].command = ['node', '-e', 'process.exit(0)'];
    const stale = await verify(task, dir, true);
    assert.equal(stale.status, 'rejected');
    assert.equal(stale.receipts[0].status, 'inconclusive');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('API checker validates real JSON Schema and refuses unapproved hosts without fetch', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ status: 42 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const c = {
      type: 'api_contract',
      url: 'http://localhost/health',
      responseSchema: {
        type: 'object',
        required: ['status'],
        properties: { status: { type: 'string' } },
        additionalProperties: false,
      },
    };
    const result = await checkers.get('api_contract')(c, {
      config: { ...gateDefaults.acceptanceGate, allowedHosts: ['localhost'] },
    });
    assert.equal(result.status, 'fail');
    const denied = await checkers.get('api_contract')(
      { ...c, url: 'http://elsewhere/health' },
      { config: gateDefaults.acceptanceGate },
    );
    assert.equal(denied.status, 'not-run');
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
