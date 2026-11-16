/**
 * Pure decision units for `/gate` — no TUI, no fs, no child process.
 *
 * Everything here answers a question the extension used to answer by accident:
 *
 * 1. **Which contract is this session working on?** `extension.mjs` used to fall back
 *    to `tasks[0]`, i.e. the first file of `.pi/tasks/` in alphabetical order, and
 *    verified that one without telling anybody. Selection is now an explicit, ranked
 *    decision with a stated reason (`pickContract`), and the reason is what `status`
 *    prints.
 * 2. **What can this session actually run?** A checker whose executable is not
 *    installed, or whose host is not allowlisted, is a *capability* fact, not a test
 *    result. `capabilityReason` names it (`mvn-not-installed`, `host-not-allowlisted`),
 *    and `scopeView` says whether it is inside the gate's scope.
 * 3. **How many continuations are allowed?** `continuationCap` keeps the existing
 *    `Math.min(1, …)` clamp but exposes it, because a limit nobody sees reads as a bug.
 *
 * All functions are synchronous and total: given the same input they return the same
 * output, which is what makes them testable without a terminal.
 */

import { stringify } from 'yaml';

/** Risk order used for tie-breaks (a riskier contract is the more demanding promise). */
export const RISK_ORDER = ['low', 'moderate', 'high', 'critical'];

/** What an `arm` authorization can be scoped to, and what gets persisted for each. */
export const ARM_SCOPES = ['once', 'ttl', 'always'];

/** TTL choices the panel offers for `arm`. `seconds` is what gets persisted. */
export const TTL_CHOICES = [
  { value: '15min', seconds: 900 },
  { value: '1h', seconds: 3600 },
  { value: '8h', seconds: 28800 },
];

/**
 * The submenu rows, and the only way to reach them: each one names the two table
 * fields it writes, so a row can never invent a value the table would refuse.
 */
export const ARM_ACTIONS = [
  { value: 'once', scope: 'once', seconds: null },
  ...TTL_CHOICES.map((t) => ({ value: `ttl:${t.value}`, scope: 'ttl', seconds: t.seconds })),
  { value: 'always', scope: 'always', seconds: 28800 },
];
/** `/gate arm 1h` is the same act as choosing `ttl:1h` in the panel. */
export const armAction = (value) =>
  ARM_ACTIONS.find((a) => a.value === value) ??
  ARM_ACTIONS.find((a) => a.value === `ttl:${value}`) ??
  // `/gate arm ttl` says the scope without the window: the window already in the file
  // (`approvalTtlSeconds`, default 900 = 15min) is the one it means.
  (value === 'ttl' ? ARM_ACTIONS.find((a) => a.value === 'ttl:15min') : null);

/** Approximate cost of running one criterion, for "ordered by the cost of *that* task". */
export const CHECKER_COST = {
  file: 1,
  documentation: 1,
  git_diff: 2,
  claim: 2,
  human: 3,
  human_review: 3,
  lint: 4,
  test: 5,
  command: 5,
  idempotency: 6,
  static_analysis: 6,
  api_contract: 7,
  coverage: 8,
  build: 9,
  vulnerability: 10,
};

export const TIE_LIMIT = 4;

const text = (v) => String(v ?? '');

/** A glob minus its trailing `/**` and wildcards, good enough to name an area. */
function areaOf(pattern) {
  return text(pattern).replace(/[\\\/]\*\*$/, '').replace(/\*\*?$/, '').replace(/^\.\/?/, '');
}

/**
 * `git status --porcelain -z` output → the paths this session has touched.
 * Renames arrive as `R\u0000old\u0000new`, so both sides are kept: a contract is
 * about an area, and the area moved.
 */
export function changedPathsFromStatus(status) {
  const fields = text(status).split('\0').filter((f) => f !== '');
  const paths = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.length > 3 && field[2] === ' ') {
      // `XY path`, the same convention the `git_diff` checker reads with `slice(3)`.
      paths.push(field.slice(3));
      if (/^[RC]/.test(field.slice(0, 2))) {
        const from = fields[i + 1];
        if (from && !(from.length > 3 && from[2] === ' ')) {
          paths.push(from);
          i += 1;
        }
      }
    } else if (!field.includes(' ')) paths.push(field); // rename tail of the previous entry
  }
  return [...new Set(paths.filter(Boolean))];
}

/**
 * Does one contract path pattern talk about this file? Deliberately simpler than
 * `glob()` in lib/core.mjs: this is a *ranking* signal, not a permission check, and a
 * coarse area match is enough to say "TASK-002 covers src/auth, TASK-001 does not".
 */
export function covers(pattern, path) {
  const p = text(pattern);
  if (!p) return false;
  if (p === '**') return true;
  const prefix = p.replace(/\/?(?:\*\*|\*).*$/, '').replace(/\/$/, '');
  if (prefix && (path === prefix || path.startsWith(prefix + '/'))) return true;
  if (p.startsWith('*') && path.endsWith(p.slice(1))) return true;
  return path === p;
}

/** The path promises one criterion makes, if any. */
export function criterionPatterns(criterion) {
  return {
    allowed: (criterion?.allowedPaths ?? []).map(text).filter(Boolean),
    forbidden: (criterion?.forbiddenPaths ?? []).map(text).filter(Boolean),
  };
}

/** Paths a contract talks about (its `git_diff` criteria), for the "por quê" line. */
export function contractAreas(task) {
  const areas = new Set();
  for (const c of task?.acceptance ?? []) {
    const { allowed, forbidden } = criterionPatterns(c);
    for (const p of [...allowed, ...forbidden]) {
      const a = areaOf(p);
      if (a) areas.add(a);
    }
  }
  return [...areas];
}

const anyCover = (patterns, path) => patterns.some((g) => covers(g, path));

/**
 * How well one contract fits the files actually changed.
 *
 * +1 per changed path inside an `allowedPaths` area (the work is inside the promise),
 * +1 per criterion that names a changed area at all, −2 per changed path that trips a
 * `forbiddenPaths` area (the contract says "don't touch that", so it is the contract
 * being violated — a strong signal it is the one in force, and it must not be hidden).
 */
export function scoreContract(task, changed = []) {
  const criteria = (task?.acceptance ?? []).map(criterionPatterns);
  const allowed = criteria.flatMap((c) => c.allowed).filter((p) => p !== '**');
  const forbidden = criteria.flatMap((c) => c.forbidden);
  const areas = contractAreas(task);
  let covered = 0;
  let violations = 0;
  for (const path of changed) {
    if (anyCover(allowed, path)) covered++;
    if (anyCover(forbidden, path)) violations++;
  }
  const named = areas.filter((a) => changed.some((p) => p.startsWith(a + '/') || p === a)).length;
  const reasonCodes = [];
  if (covered) reasonCodes.push(`allowed-hits:${covered}`);
  if (named) reasonCodes.push(`area-hits:${named}`);
  if (violations) reasonCodes.push(`forbidden-hits:${violations}`);
  if (!changed.length) reasonCodes.push('no-diff-evidence');
  if (!allowed.length && !forbidden.length && !areas.length)
    reasonCodes.push('contract-declares-no-paths');
  return {
    taskId: task?.id ?? '?',
    score: covered + named - 2 * violations,
    covered,
    named,
    violations,
    checkers: (task?.acceptance ?? []).length,
    risk: task?.risk ?? 'moderate',
    areas,
    reasonCodes,
  };
}

/** Ranked, deterministic: score, then risk, then number of checkers, then id. */
export function rankContracts(tasks = [], changed = []) {
  const scored = tasks.map((t) => scoreContract(t, changed));
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      RISK_ORDER.indexOf(b.risk) - RISK_ORDER.indexOf(a.risk) ||
      b.checkers - a.checkers ||
      text(a.taskId).localeCompare(text(b.taskId)),
  );
  const tie = scored.length > 1 && scored[0].score === scored[1].score;
  return { scored, tie, changedCount: changed.length };
}

/**
 * The selection decision itself.
 *
 * `mode` is the honest answer to "why this contract":
 * `explicit` (a human said `/gate use`), `single` (one contract exists — announced,
 * because a silent auto-pick is what made the extension look arbitrary), `ranked`
 * (one contract clearly fits the diff), `tie` (a choice is owed to the human),
 * `needs-choice` (autoSelect off, so nothing is picked without asking), `none`.
 */
export function pickContract({
  tasks = [],
  changed = [],
  config = {},
  explicitId = null,
  autoSelect = config.autoSelect !== false,
} = {}) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const ranked = rankContracts(tasks, changed);
  if (!tasks.length)
    return {
      contract: null,
      mode: 'none',
      ranked,
      reasonCodes: ['no-contracts'],
      reason: 'nenhum contrato em .pi/tasks/ — pergunte e ajude a criar um',
    };
  if (explicitId && byId.has(explicitId))
    return {
      contract: byId.get(explicitId),
      mode: 'explicit',
      ranked,
      reasonCodes: ['explicit-selection'],
      reason: `escolha explícita: /gate use ${explicitId}`,
    };
  if (!autoSelect)
    return {
      contract: null,
      mode: 'needs-choice',
      ranked,
      reasonCodes: ['auto-select-off'],
      ask: true,
      reason: `autoSelect está off e há ${tasks.length} contratos — nada é verificado sem você escolher`,
    };
  if (tasks.length === 1)
    return {
      contract: tasks[0],
      mode: 'single',
      ranked,
      reasonCodes: ['single-contract', 'announced'],
      reason: `único contrato do projeto, selecionado automaticamente (${tasks[0].id})`,
    };
  const top = ranked.scored[0];
  if (ranked.tie)
    return {
      contract: byId.get(top.taskId),
      mode: 'tie',
      ranked,
      ask: true,
      recommended: top.taskId,
      reasonCodes: ['tie', `${tasks.length}-candidates`, `top:${top.taskId}`],
      reason: `empate entre ${tasks.length} contratos — recomendado ${top.taskId} (${top.reasonCodes.join(' · ') || 'critério de desempate: risco'})`,
    };
  return {
    contract: byId.get(top.taskId),
    mode: 'ranked',
    ranked,
    recommended: top.taskId,
    reasonCodes: top.reasonCodes.length ? top.reasonCodes : ['risk-tiebreak'],
    reason: `aderência aos ${changed.length} arquivo(s) alterados: ${top.reasonCodes.join(' · ') || `risco ${top.risk}`}`,
  };
}

/**
 * The continuation clamp, made visible.
 *
 * `agent_before_settle` has always capped continuations at 1 (`Math.min(1, …)`) no
 * matter what the contract or the config asked for. The clamp stays — it is what keeps
 * the gate from looping — but a ceiling that exists only in a closure is a surprise,
 * so it is reported: `continuações: 1 (teto global)`.
 */
export function continuationCap(contractMax, configMax) {
  const requested = Math.min(
    Number.isFinite(contractMax) ? contractMax : 0,
    Number.isFinite(configMax) ? configMax : 0,
  );
  const applied = Math.min(1, requested);
  const reasonCodes = ['effective:1'];
  if (requested > applied) reasonCodes.push('capped-by-global-limit:1');
  if (contractMax != null && configMax != null && configMax < contractMax)
    reasonCodes.push('global-limit-binds');
  return { requested, applied, reasonCodes };
}

/** Is the missing thing an executable, a host or a checker blowing up? */
export function capabilityReason(error) {
  const message = text(error?.message ?? error);
  const named = /Command not allowed:\s*([\w.@/-]+)/i.exec(message);
  if (named) return { code: `exe-not-allowlisted:${named[1]}`, kind: 'executable', exe: named[1] };
  if (/Command not allowed/i.test(message)) {
    const exe = text(error?.exe);
    return { code: exe ? `exe-not-allowlisted:${exe}` : 'exe-not-allowlisted', kind: 'executable', exe };
  }
  const missing = /^(ENOENT|ERR_MODULE_NOT_FOUND)$/i.test(message) || /no such file|not found/i.test(message);
  if (missing) {
    const exe = text(error?.exe);
    // An ENOENT that names no executable came from reading an artifact, not from
    // spawning a binary — that is a real problem with the evidence, not a missing
    // capability, and it must not be relabelled `out-of-scope`.
    return exe
      ? { code: `${exe}-not-installed`, kind: 'executable', exe }
      : { code: 'artifact-missing', kind: 'artifact' };
  }
  if (/host not allowlisted/i.test(message))
    return { code: 'host-not-allowlisted', kind: 'host', host: text(error?.host) };
  if (/Git (failed|repository required)/i.test(message))
    return { code: 'git-unavailable', kind: 'tooling' };
  return { code: `checker-error:${message.split('\n')[0].slice(0, 80)}`, kind: 'checker' };
}

/**
 * What the user should see for one receipt.
 *
 * The machine status (`inconclusive`, `not-run`) stays untouched — CI exit codes and
 * existing evidence depend on it — but the *display* says `out-of-scope` when the
 * blocker was a capability the session does not have, together with the real reason.
 */
export function scopeView(receipt, config = {}) {
  const out = receipt?.outOfScope === true;
  const source = config.scope?.source ?? 'available';
  if (out && source === 'available')
    return { display: 'out-of-scope', blocking: config.scope?.strict !== false, reason: receipt.reasonCode ?? 'capability-missing' };
  return { display: receipt?.status ?? '?', blocking: !['pass', 'needs-human'].includes(receipt?.status), reason: receipt?.error ?? receipt?.reasonCode ?? null };
}

/** Criteria of one contract that a given session cannot run, cheapest first elsewhere. */
export function outOfScopeReceipts(report, config = {}) {
  return (report?.receipts ?? []).filter((r) => scopeView(r, config).display === 'out-of-scope');
}

/** Order candidates (checkers, executables, hosts) by what they would cost *this* task. */
export function byCost(items, costOf = (i) => CHECKER_COST[i?.type] ?? 5) {
  return [...items].sort(
    (a, b) =>
      costOf(a) - costOf(b) ||
      text(a?.id ?? a?.value ?? a).localeCompare(text(b?.id ?? b?.value ?? b)),
  );
}

/** Label with the recommendation marker on the first candidate (rule F). */
export function recommendedLabel(row, index, detail) {
  return `${index === 0 ? '▸ recomendado ' : ''}${row.id ?? text(row)} · ${detail}`;
}

/** Checkers suggested for a new contract, cheapest first, as panel rows. */
export function suggestCheckers({ nodeProject = true, hasGit = true, allowHosts = false } = {}) {
  // `cost` here is what the *user* pays for the evidence: a git_diff is free and
  // automatic, `node --test` is a machine run, and a human review is the most expensive
  // checker there is — which is exactly why it is offered last, not first.
  const rows = [];
  rows.push({
    id: 'diff-scope',
    type: 'git_diff',
    allowedPaths: ['**'],
    forbiddenPaths: ['.env', 'secrets/**'],
    required: true,
    cost: 2,
    why: hasGit ? 'de graça: só lê o status do git' : 'sem git vira inconclusive',
  });
  if (nodeProject)
    rows.push({
      id: 'tests',
      type: 'test',
      command: 'node --test',
      required: true,
      cost: 5,
      why: 'roda a suíte do repo — o mais barato que ainda é evidência',
    });
  if (allowHosts)
    rows.push({
      id: 'api',
      type: 'api_contract',
      url: '',
      required: false,
      cost: 7,
      why: 'precisa de host em acceptanceGate.allowedHosts',
    });
  rows.push({
    id: 'review',
    type: 'human_review',
    required: false,
    cost: 9,
    why: 'zero máquinas, todo o humano: exige /gate approve <justificativa>',
  });
  return byCost(rows, (r) => r.cost);
}

/** The contract document a guided creation would write, as YAML text. */
export function draftContract({
  id,
  title,
  risk = 'moderate',
  checkers,
  acceptance,
  maxAutoRevisions = 2,
}) {
  // `checkers` is the suggestion list, `acceptance` is the same thing already shaped by
  // the caller (extension.mjs builds the document it validates). Accepting either is
  // what keeps the writer from silently emitting `acceptance: []` — a contract with no
  // evidence, which `loadTasks` then refuses to read back.
  const rows = checkers ?? acceptance ?? [];
  // Written with the YAML writer, not with template strings: a compact `- a: 1, b: [2]`
  // line is not valid YAML, and a contract the verifier cannot read is worse than none.
  return stringify(
    {
      task: {
        id,
        title,
        risk,
        acceptance: rows.map((c) => ({
          id: c.id,
          type: c.type,
          ...(c.command ? { command: c.command } : {}),
          ...(c.path ? { path: c.path } : {}),
          ...(c.url ? { url: c.url } : {}),
          ...(c.allowedPaths ? { allowedPaths: c.allowedPaths } : {}),
          ...(c.forbiddenPaths ? { forbiddenPaths: c.forbiddenPaths } : {}),
          required: c.required !== false,
        })),
        maxAutoRevisions,
      },
    },
    { lineWidth: 0 },
  );
}
