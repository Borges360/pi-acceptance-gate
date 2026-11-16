import { readFile, readdir, stat } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { join, extname } from 'node:path';
import {
  hash,
  now,
  uid,
  actor,
  snapshot,
  safePath,
  processRun,
  glob,
  words,
  yamlFile,
  redact,
} from './lib/core.mjs';
import { capabilityReason } from './select.mjs';
export { snapshot } from './lib/core.mjs';

/** Receipts carry the verifier version: bump it with the package, 0.2.0 → 0.3.0. */
export const VERIFIER_VERSION = '0.3.0';

/**
 * Is the executable of a criterion even installed? `where`/`which` answers once per
 * process; if the finder itself is missing we cannot prove absence, so the criterion
 * stays in scope and the real run says what it has to say.
 */
const probeCache = new Map();
export async function executableAvailable(exe, root) {
  const key = `${process.platform}:${exe}`;
  if (probeCache.has(key)) return probeCache.get(key);
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const r = await processRun(finder, [exe], { cwd: root, timeoutMs: 5000 });
  const available = r.error === 'ENOENT' ? true : r.code === 0 && r.output.trim() !== '';
  probeCache.set(key, available);
  return available;
}
export const probeCacheClear = () => probeCache.clear();
/** The gate scope in force for a config fragment. */
export const scopeSource = (config) => config?.scope?.source ?? 'available';

export const gateDefaults = {
  acceptanceGate: {
    enabled: true,
    autoVerifyOnCandidate: false,
    maxAutoRevisions: 2,
    continueForPendingChecks: false,
    /**
     * With more than one contract in `.pi/tasks/`, which one this session works on used
     * to be decided by the alphabetical order of the files (`tasks[0]`). `autoSelect`
     * keeps the convenience for the unambiguous cases (one contract, or one contract
     * that clearly matches the diff) and asks when it is not unambiguous; turning it
     * off makes every session ask, never guess.
     */
    autoSelect: true,
    /** How long an `arm` authorization lasts: once | ttl | always. */
    armScope: 'ttl',
    /**
     * The gate's scope is what this session can actually run (`available`). `declared`
     * insists on every criterion in the contract, which is the pre-0.3 behaviour: the
     * same reasons, but reported as failures of the run instead of missing capability.
     */
    scope: { source: 'available', strict: true },
    allowedExecutables: [
      'node',
      'npm',
      'mvn',
      'mvnw',
      'gradle',
      'gradlew',
      'go',
      'dotnet',
      'pytest',
      'terraform',
    ],
    allowedHosts: [],
    ignorePaths: ['.pi/tasks/**', '.pi/acceptance.json'],
    approvalTtlSeconds: 900,
  },
};
export const transitions = {
  draft: ['in_progress'],
  in_progress: ['candidate'],
  candidate: ['verifying'],
  verifying: ['accepted', 'rejected', 'needs_human_review'],
  rejected: ['in_progress'],
  accepted: ['in_progress'],
  needs_human_review: ['in_progress'],
};
export function transition(task, next) {
  if (!transitions[task.status]?.includes(next))
    throw Error(`Forbidden gate transition ${task.status} -> ${next}`);
  return { ...task, status: next, updatedAt: now() };
}
export function validate(document) {
  const raw = document.task ?? document;
  const acceptance = raw.acceptance ?? raw.criteria;
  if (!Array.isArray(acceptance) || !acceptance.length) throw Error('Acceptance criteria required');
  const ids = new Set();
  const allowedTypes = [
    'test',
    'command',
    'static_analysis',
    'lint',
    'build',
    'git_diff',
    'coverage',
    'api_contract',
    'vulnerability',
    'idempotency',
    'file',
    'documentation',
    'human_review',
    'human',
    'claim',
  ];
  for (const c of acceptance) {
    if (!/^[\w-]{1,64}$/.test(c.id ?? '') || ids.has(c.id))
      throw Error('Invalid/duplicate criterion id');
    ids.add(c.id);
    if (!allowedTypes.includes(c.type)) throw Error('Unknown checker');
    if (c.command != null && typeof c.command !== 'string' && !Array.isArray(c.command))
      throw Error('Invalid command');
    if (
      c.command &&
      words(Array.isArray(c.command) ? c.command.join(' ') : c.command).some((p) =>
        /[;&|`<>\r\n]/.test(p),
      )
    )
      throw Error('Command not allowed: shell interpolation');
    if (
      c.command &&
      /^(rm|curl|wget|bash|sh|powershell|pwsh|cmd)(?:\s|$)/.test(
        Array.isArray(c.command) ? c.command.join(' ') : c.command,
      )
    )
      throw Error('Command not allowed');
    if (
      c.timeoutSeconds != null &&
      (!Number.isFinite(c.timeoutSeconds) || c.timeoutSeconds < 1 || c.timeoutSeconds > 3600)
    )
      throw Error('Invalid timeout');
    if (c.condition && !/^risk\s*(>=|==)\s*(low|moderate|high|critical)$/.test(c.condition))
      throw Error('Invalid condition');
    if (c.required != null && typeof c.required !== 'boolean') throw Error('Invalid required');
  }
  const task = {
    id: raw.id ?? 'TASK-DEFAULT',
    title: raw.title ?? 'Acceptance checks',
    risk: raw.risk ?? 'moderate',
    acceptance,
    maxAutoRevisions: raw.maxAutoRevisions ?? 2,
    onFailure: raw.onFailure ?? 'report-and-request-correction',
    forbiddenTools: raw.forbiddenTools ?? [],
  };
  if (
    !/^[\w-]{1,100}$/.test(task.id) ||
    !['low', 'moderate', 'high', 'critical'].includes(task.risk) ||
    !Number.isInteger(task.maxAutoRevisions) ||
    task.maxAutoRevisions < 0 ||
    task.maxAutoRevisions > 10
  )
    throw Error('Invalid task contract');
  if (raw.definitionOfDone != null) {
    const d = raw.definitionOfDone;
    const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
    if (
      !d ||
      d.schemaVersion !== 1 ||
      !text(d.objective, 4000) ||
      !text(d.template, 100) ||
      !text(d.assistant, 300) ||
      !Array.isArray(d.answers) ||
      !d.answers.length ||
      d.answers.length > 6 ||
      d.answers.some((a) => !text(a?.question, 300) || !text(a?.answer, 4000)) ||
      !Array.isArray(d.plan) ||
      !d.plan.length ||
      d.plan.length > 12 ||
      d.plan.some((s) => !text(s, 4000))
    )
      throw Error('Invalid definition of done');
    task.definitionOfDone = {
      schemaVersion: 1,
      objective: d.objective,
      template: d.template,
      assistant: d.assistant,
      answers: d.answers.map((a) => ({ question: a.question, answer: a.answer })),
      plan: [...d.plan],
    };
  }
  return task;
}
export async function loadTasks(root) {
  const tasks = [];
  let files = [];
  try {
    files = await readdir(join(root, '.pi', 'tasks'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  for (const file of files.filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const doc = await yamlFile(await safePath(root, `.pi/tasks/${file}`, { existing: true }));
    for (const task of doc.tasks ?? [doc]) tasks.push(validate(task));
  }
  if (!tasks.length) {
    try {
      tasks.push(
        validate(
          JSON.parse(
            await readFile(await safePath(root, '.pi/acceptance.json', { existing: true }), 'utf8'),
          ),
        ),
      );
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  if (new Set(tasks.map((t) => t.id)).size !== tasks.length) throw Error('Duplicate task IDs');
  return tasks;
}
function conditional(task, c) {
  if (!c.condition) return true;
  const [, op, risk] = /^risk\s*(>=|==)\s*(\w+)$/.exec(c.condition);
  const levels = ['low', 'moderate', 'high', 'critical'];
  return op === '==' ? task.risk === risk : levels.indexOf(task.risk) >= levels.indexOf(risk);
}
export function commandSpec(command, config) {
  const parts = Array.isArray(command) ? command : words(command);
  if (!parts.length || parts.some((p) => typeof p !== 'string' || /[\r\n\0;&|`<>]/.test(p)))
    throw Error('Shell interpolation denied');
  const exe = parts[0].replace(/^\.\//, '').replace(/\.cmd$/, '');
  if (!config.allowedExecutables.includes(exe))
    throw Error(`Command not allowed: ${exe} is not in acceptanceGate.allowedExecutables`);
  if (process.platform === 'win32' && ['npm', 'mvnw', 'gradlew'].includes(exe)) {
    if (parts.some((p) => /["%!^]/.test(p))) throw Error('Unsafe Windows argument');
    return {
      exe: 'cmd.exe',
      args: ['/d', '/s', '/c', parts.map((p) => `"${p}"`).join(' ')],
      firstToken: exe,
    };
  }
  return { exe: parts[0], args: parts.slice(1), firstToken: exe };
}
export function sanitizeCommand(command) {
  const parts = Array.isArray(command) ? [...command] : words(command);
  for (let i = 0; i < parts.length; i++) {
    if (/^--?(?:api[-_]?key|password|token|secret)$/i.test(parts[i]) && i + 1 < parts.length)
      parts[++i] = '[REDACTED]';
    else parts[i] = redact(parts[i]);
  }
  return parts.join(' ');
}
export const checkers = new Map();
export function registerChecker(type, fn) {
  if (checkers.has(type)) throw Error('Checker already registered');
  checkers.set(type, fn);
}
async function commandCheck(c, { root, config, signal }) {
  if (!c.command) return { status: 'not-run', error: 'No checker command' };
  let spec;
  try {
    spec = commandSpec(c.command, config);
  } catch (error) {
    // An executable outside `allowedExecutables` is a statement about this session's
    // scope, not a test that failed. Before 0.3 the same throw landed in the generic
    // `inconclusive` catch, so "mvn is not allowlisted" and "mvn exited 1" were
    // indistinguishable in the report.
    const cap = capabilityReason(error);
    return { status: 'not-run', error: cap.code, reasonCode: cap.code, outOfScope: true };
  }
  if (!(await executableAvailable(spec.firstToken, root))) {
    const code = `${spec.firstToken}-not-installed`;
    return {
      status: 'not-run',
      error: code,
      reasonCode: code,
      outOfScope: scopeSource(config) === 'available',
    };
  }
  const r = await processRun(spec.exe, spec.args, {
    cwd: root,
    timeoutMs: (c.timeoutSeconds ?? 120) * 1000,
    signal,
  });
  if (r.error) {
    const code =
      r.error === 'timeout'
        ? 'checker-timeout'
        : r.error === 'ENOENT'
          ? `${spec.firstToken}-not-installed`
          : String(r.error);
    return {
      status: 'inconclusive',
      error: code,
      reasonCode: code,
      exitCode: r.code,
      reportDigest: r.digest,
    };
  }
  return {
    status: r.code === (c.expectedExitCode ?? 0) ? 'pass' : 'fail',
    exitCode: r.code,
    error: null,
    reportDigest: r.digest,
  };
}
for (const type of ['command', 'test', 'lint', 'build', 'static_analysis', 'idempotency'])
  registerChecker(type, commandCheck);
registerChecker('claim', async () => ({
  status: 'not-run',
  error: 'A model claim is not verifier evidence',
}));
registerChecker('git_diff', async (c, { root }) => {
  const r = await processRun(
    'git',
    ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'],
    { cwd: root },
  );
  if (r.code !== 0) return { status: 'inconclusive', error: 'Git failed' };
  const paths = r.output
    .split('\0')
    .filter(Boolean)
    .map((p) => p.slice(3));
  const denied = paths.filter(
    (p) =>
      (c.forbiddenPaths ?? ['.env', 'secrets/**']).some((g) => glob(g, p)) ||
      !(c.allowedPaths ?? ['**']).some((g) => glob(g, p)),
  );
  return {
    status: denied.length ? 'fail' : 'pass',
    error: denied.length ? 'Paths violate contract' : null,
    reportDigest: hash(paths),
  };
});
for (const type of ['file', 'documentation'])
  registerChecker(type, async (c, { root }) => {
    const data = await readFile(await safePath(root, c.path, { existing: true }), 'utf8');
    return {
      status: !c.contains || data.includes(c.contains) ? 'pass' : 'fail',
      reportDigest: hash(data),
      artifactPaths: [c.path],
    };
  });
async function stamp(root, path) {
  try {
    const s = await stat(await safePath(root, path));
    return `${s.mtimeMs}/${s.ctimeMs}/${s.size}`;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
registerChecker('coverage', async (c, context) => {
  const before = await stamp(context.root, c.reportPath);
  const r = await commandCheck(c, context);
  if (r.status !== 'pass') return r;
  const file = await safePath(context.root, c.reportPath, { existing: true });
  if ((await stamp(context.root, c.reportPath)) === before)
    return { ...r, status: 'inconclusive', error: 'Coverage artifact was not regenerated' };
  const data = JSON.parse(await readFile(file, 'utf8'));
  const total = data.total ?? data.coverage ?? data;
  const percentages = c.thresholds ?? { lines: c.minimumPercent ?? 80 };
  const ok = Object.entries(percentages).every(
    ([k, min]) => Number.isFinite(total[k]?.pct ?? total[k]) && (total[k]?.pct ?? total[k]) >= min,
  );
  return {
    ...r,
    status: ok ? 'pass' : 'fail',
    artifactPaths: [c.reportPath],
    reportDigest: hash(data),
  };
});
registerChecker('vulnerability', async (c, context) => {
  const before = c.reportPath ? await stamp(context.root, c.reportPath) : null;
  const r = await commandCheck(c, context);
  if (r.status !== 'pass') return r;
  if (!c.reportPath) return r;
  if ((await stamp(context.root, c.reportPath)) === before)
    return { ...r, status: 'inconclusive', error: 'Vulnerability artifact was not regenerated' };
  const data = JSON.parse(
    await readFile(await safePath(context.root, c.reportPath, { existing: true }), 'utf8'),
  );
  const counts = data.metadata?.vulnerabilities ?? data.vulnerabilities;
  if (!counts) return { ...r, status: 'inconclusive', error: 'Unsupported vulnerability report' };
  const severities = c.denySeverities ?? ['high', 'critical'];
  return {
    ...r,
    status: severities.every((s) => Number.isFinite(counts[s]) && counts[s] === 0)
      ? 'pass'
      : 'fail',
    artifactPaths: [c.reportPath],
    reportDigest: hash(data),
  };
});
registerChecker('api_contract', async (c, { config, signal }) => {
  const validateResponse = c.responseSchema
    ? new Ajv2020({ strict: true, allErrors: false }).compile(c.responseSchema)
    : null;
  const url = new URL(c.url);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !config.allowedHosts.includes(url.hostname)
  ) {
    // Same story as an uninstalled executable: this is the scope of the session, and
    // the fix is `acceptanceGate.allowedHosts` (a widening that needs a human), not
    // "the endpoint is broken".
    const code = `host-not-allowlisted:${url.hostname}`;
    return {
      status: 'not-run',
      error: code,
      reasonCode: code,
      outOfScope: scopeSource(config) === 'available',
    };
  }
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout((c.timeoutSeconds ?? 30) * 1000)])
      : AbortSignal.timeout((c.timeoutSeconds ?? 30) * 1000),
  });
  const reader = response.body?.getReader();
  let bytes = 0;
  const chunks = [];
  if (reader)
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 1_000_000) {
        await reader.cancel();
        return { status: 'inconclusive', error: 'Response too large' };
      }
      chunks.push(Buffer.from(part.value));
    }
  const text = Buffer.concat(chunks).toString('utf8');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  const ok =
    response.status === (c.expectedStatus ?? 200) &&
    (c.requiredKeys ?? []).every((k) => data && Object.hasOwn(data, k)) &&
    (!validateResponse || validateResponse(data));
  return { status: ok ? 'pass' : 'fail', reportDigest: hash(text) };
});
export function evidenceIgnore(task, config) {
  return [
    ...config.ignorePaths,
    ...task.acceptance
      .map((c) => c.reportPath)
      .filter((p) => typeof p === 'string' && /^(coverage|reports|artifacts)\//.test(p)),
  ];
}
export async function verify(document, root, confirmed, human = false, options = {}) {
  const task = validate(document),
    config = { ...gateDefaults.acceptanceGate, ...options.config };
  if (!confirmed) throw Error('Explicit confirmation required');
  const ignorePaths = evidenceIgnore(task, config);
  const before = await snapshot(root, { ignorePaths }),
    contractHash = hash(task);
  const receipts = [];
  for (const c of task.acceptance) {
    const startedAt = now();
    const base = {
      id: uid(),
      criterionId: c.id,
      type: c.type,
      commandHash: c.command ? hash(c.command) : null,
      commandSanitized: c.command ? sanitizeCommand(c.command) : null,
      startedAt,
      commitHash: before.commitHash,
      workingTreeHash: before.workingTreeHash,
      contractHash,
      artifactPaths: [],
      reportDigest: null,
      verifierVersion: VERIFIER_VERSION,
      actor: actor(),
    };
    let result;
    if (!conditional(task, c))
      result = { status: 'skipped-with-reason', error: 'Condition not applicable' };
    else if (['human', 'human_review'].includes(c.type))
      result = {
        status: human === true || (await options.isApproved?.(c, base)) ? 'pass' : 'needs-human',
        error: null,
      };
    else if (options.signal?.aborted) result = { status: 'not-run', error: 'Aborted' };
    else
      try {
        result = await checkers.get(c.type)(c, { root, config, signal: options.signal });
      } catch (e) {
        // A checker that throws is not a checker that failed: name the kind of missing
        // capability (executable, host, tooling) instead of flattening it into the same
        // anonymous `inconclusive` as a red exit code.
        const cap = capabilityReason(e);
        result = {
          status: 'inconclusive',
          error: redact(e.message),
          reasonCode: cap.code,
          outOfScope:
            ['executable', 'host', 'tooling'].includes(cap.kind) &&
            scopeSource(config) === 'available',
        };
      }
    const receipt = { ...base, ...result, finishedAt: now() };
    receipts.push(receipt);
    await options.onReceipt?.(receipt);
  }
  const after = await snapshot(root, { ignorePaths });
  const stale =
    before.workingTreeHash !== after.workingTreeHash || before.commitHash !== after.commitHash;
  const required = receipts.filter(
    (r, i) => task.acceptance[i].required !== false && conditional(task, task.acceptance[i]),
  );
  const outOfScope = receipts.filter((r) => r.outOfScope === true);
  /**
   * `scope.strict: false` is the only way a criterion leaves the verdict, and only when
   * the scope was chosen as `available`. With the default (`strict: true`) an
   * out-of-scope required criterion still blocks acceptance exactly as it did before:
   * the *reason* changes, no existing acceptance does.
   */
  const relaxed = scopeSource(config) === 'available' && config.scope?.strict === false;
  const blocking = relaxed ? required.filter((r) => !r.outOfScope) : required;
  const status =
    stale || blocking.some((r) => !['pass', 'needs-human'].includes(r.status))
      ? 'rejected'
      : blocking.some((r) => r.status === 'needs-human')
        ? 'needs_human_review'
        : 'accepted';
  const failing = blocking.find((r) => !['pass', 'needs-human'].includes(r.status));
  return {
    status,
    reason:
      (stale
        ? 'Relevant snapshot changed during verification'
        : failing?.reasonCode ?? failing?.error ?? null) ??
      (outOfScope.length
        ? `${outOfScope.length} critério(s) fora do escopo desta sessão: ${outOfScope
            .map((r) => `${r.criterionId} (${r.reasonCode ?? r.error})`)
            .join(', ')}`
        : null),
    outOfScope,
    scope: {
      source: scopeSource(config),
      strict: config.scope?.strict !== false,
      relaxed,
    },
    blockingIds: blocking
      .filter((r) => !['pass', 'needs-human'].includes(r.status))
      .map((r) => r.criterionId),
    receipts,
    taskId: task.id,
    contractHash,
    snapshot: before,
    finishedAt: now(),
  };
}
