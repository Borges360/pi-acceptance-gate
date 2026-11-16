import {
  createRuntime,
  scopeOf,
  setTask,
  output,
  usageText,
  buildCompletions,
  words,
  uid,
  hash,
  now,
  actor,
  snapshot,
  safePath,
  glob,
  processRun,
} from './lib/core.mjs';
import {
  gateDefaults,
  loadTasks,
  validate as validateContract,
  verify,
  transition,
  evidenceIgnore,
  VERIFIER_VERSION,
} from './gate.mjs';
import { createAcceptance, templates } from './acceptance.mjs';
import {
  FIELDS,
  applyField,
  fieldValues,
  panelItems,
  panelTitle,
  checkerLines,
  reportLines,
  armRows,
  runDashboard,
  provideHost,
  mergePatch,
} from './menu.mjs';
import {
  pickContract,
  continuationCap,
  changedPathsFromStatus,
  suggestCheckers,
  draftContract,
  ARM_ACTIONS,
  armAction,
  RISK_ORDER,
  CHECKER_COST,
  byCost,
  recommendedLabel,
} from './select.mjs';
import {
  languageName,
  loadProjectLanguage,
  saveProjectLanguage,
  translateText,
} from './lib/i18n.mjs';
import { writeFile, mkdir, link, unlink, open, access, rmdir } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

/** `/gate allow exe mvn` — the two widening targets, named so help can be exact. */
const WIDENING = { exe: 'allowedExecutables', host: 'allowedHosts' };
/** Text-command action → table field. One mapping, used by help and by the handler. */
const FIELD_ACTIONS = {
  scope: 'scopeSource',
  strict: 'scopeStrict',
  ttl: 'ttl',
  'arm-scope': 'armScope',
  revisions: 'maxAutoRevisions',
  'auto-select': 'autoSelect',
  autoverify: 'autoVerify',
  continue: 'continuePending',
};

async function longrunOwnsContinuation(pi, projectKey, sessionId) {
  const requestId = randomUUID();
  const envelope = { protocolVersion: 2, requestId, projectKey, sessionId, operation: 'describe' };
  let claimed = false;
  let finish;
  const answer = new Promise((resolve) => {
    finish = resolve;
  });
  const unsubscribe = pi.events.on('pi.compose.result.v2', (result) => {
    if (
      result?.source !== 'pi-longrun' ||
      result.target !== 'pi-acceptance-gate' ||
      result.payload?.capability !== 'execution.continue' ||
      Object.entries(envelope).some(([key, value]) => result[key] !== value)
    ) return;
    if (result.payload.status === 'pending') claimed = true;
    if (claimed && ['active', 'idle', 'unknown'].includes(result.payload.status)) {
      finish(result.payload.status !== 'idle');
    }
  });
  let timer;
  try {
    pi.events.emit('pi.compose.request.v2', {
      ...envelope,
      messageId: randomUUID(),
      emittedAt: new Date().toISOString(),
      source: 'pi-acceptance-gate',
      target: 'pi-longrun',
      payload: { capability: 'execution.continue' },
    });
    // A local provider acknowledges synchronously. After acknowledgement, an
    // unknown or late result leaves continuation with that provider.
    if (!claimed) return false;
    timer = setTimeout(() => finish(true), 200);
    return await answer;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

export default function gate(pi, Type, injected = {}) {
  // The entry point imported the host modules statically and hands them over here;
  // without this the panel would have to `await import()` them and degrade (index.ts
  // documents why a lazy import of `@earendil-works/pi-tui` cannot resolve).
  provideHost(injected.tui, injected.agent);
  const rt = createRuntime(pi, 'gate', gateDefaults);
  let tasks = [],
    current = null,
    selection = null,
    explicitId = null,
    busy = false,
    continuations = 0,
    armed = false,
    armedContract = null,
    armedUntil = 0,
    pendingWidening = null,
    armOnce = false,
    lastReport = null,
    panelDraftConfig = null,
    askedContract = false,
    declinedCreate = false,
    declinedWiden = false,
    announceNeeded = true,
    diffCache = { key: null, paths: [] };
  const conf = () => rt.config.acceptanceGate;
  const locked = () => rt.config.locked?.acceptanceGate ?? {};
  /**
   * `setTask` writes a session entry marking task/attempt. It is bookkeeping, not the
   * decision itself, and hosts can refuse it (`appendEntry` throws outside a running
   * session, e.g. `pi -e ./extension.mjs`, RPC without a context, or the loader's
   * un-initialized runtime). A refused marker must not lose the contract choice, so it
   * is caught — and said out loud, because silent partial application is what makes an
   * extension look broken.
   */
  const markTask = (id, attemptId) => {
    try {
      if (attemptId) setTask(pi, id, attemptId);
      else setTask(pi, id);
      return true;
    } catch (error) {
      const why = String(error?.message ?? error).split('\n')[0];
      try {
        rt.ctx?.ui?.notify?.(`gate: decisão aplicada, mas a marcação da sessão falhou (${why})`, 'warning');
      } catch {
        /* a broken notify must not replace the reason with a second error */
      }
      return false;
    }
  };

  /** Files this session has touched, for the adherence ranking (cached per leaf). */
  const changedPaths = async (ctx) => {
    const key = `${ctx.sessionManager.getLeafId()}:${tasks.map((t) => t.id).join(',')}`;
    if (diffCache.key === key) return diffCache.paths;
    let paths = [];
    try {
      const r = await processRun(
        'git',
        ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'],
        { cwd: rt.root },
      );
      if (r.code === 0) paths = changedPathsFromStatus(r.output).slice(0, 500);
    } catch {
      // No git: the ranking says `no-diff-evidence` instead of pretending it saw a diff.
    }
    diffCache = { key, paths };
    return paths;
  };

  const init = async (ctx) => {
    await rt.init(ctx);
    if (busy) return selection;
    tasks = ctx.isProjectTrusted() ? await loadTasks(rt.root) : [];
    const previous = current?.id;
    selection = pickContract({
      tasks,
      changed: await changedPaths(ctx),
      config: conf(),
      explicitId,
    });
    current = selection.contract ?? null;
    if (!current || current.id !== previous) announceNeeded = true;
    if (armed && (!current || hash(current) !== armedContract || Date.now() > armedUntil))
      armed = false;
    return selection;
  };

  /** The one-line announcement: which contract, and why it is the one. */
  const announce = (ctx) => {
    if (!announceNeeded || !selection) return;
    announceNeeded = false;
    if (!selection.contract) {
      output(ctx, `gate · contrato: nenhum · ${selection.reason}`, 'info');
      return;
    }
    output(
      ctx,
      `gate · contrato: ${selection.contract.id} · ${selection.reason}${selection.mode === 'single' || selection.mode === 'ranked' ? ' · troque com /gate use <ID>' : ''}`,
      'info',
    );
  };

  const entity = (ctx) => `${scopeOf(ctx).sessionId}/${current?.id}`;
  const save = async (ctx, state) => {
    await rt.store.append('tasks', {
      id: uid(),
      projectId: rt.projectId,
      entityId: entity(ctx),
      ...scopeOf(ctx),
      taskId: current.id,
      anchorId: ctx.sessionManager.getLeafId(),
      ...state,
    });
    await rt.emit('task.status_changed', {
      taskId: current.id,
      status: state.status,
      attemptId: state.attemptId,
    });
  };
  const latest = async (ctx) => {
    const rows = await rt.store.rows('tasks'),
      ids = new Set(ctx.sessionManager.getBranch().map((e) => e.id));
    return (
      rows
        .filter((r) => r.entityId === entity(ctx) && (!r.anchorId || ids.has(r.anchorId)))
        .at(-1) ?? { status: 'draft', attemptId: null }
    );
  };
  const invalidate = async (ctx) => {
    const state = await latest(ctx);
    if (state.status !== 'accepted' || !state.report) return;
    let currentSnapshot;
    try {
      currentSnapshot = await snapshot(rt.root, {
        ignorePaths: evidenceIgnore(current, conf()),
      });
    } catch {
      currentSnapshot = null;
    }
    if (
      !currentSnapshot ||
      currentSnapshot.commitHash !== state.report.snapshot.commitHash ||
      currentSnapshot.workingTreeHash !== state.report.snapshot.workingTreeHash ||
      hash(current) !== state.report.contractHash
    ) {
      const next = { ...transition(state, 'in_progress'), attemptId: uid(), invalidatedAt: now() };
      markTask(current.id, next.attemptId);
      await save(ctx, next);
      await rt.emit('gate.invalidated', {
        taskId: current.id,
        reason: 'Snapshot/contract changed or cannot be verified',
      });
    }
  };
  const approved = async (c, receipt) => {
    for (const r of await rt.store.rows('approvals')) {
      if (await rt.store.valid(r.signed)) {
        const p = r.signed.payload;
        if (
          p.taskId === current.id &&
          p.criterionId === c.id &&
          p.contractHash === receipt.contractHash &&
          p.workingTreeHash === receipt.workingTreeHash &&
          p.commitHash === receipt.commitHash &&
          p.sessionId === scopeOf(rt.ctx).sessionId &&
          (p.branchId === 'root' ||
            rt.ctx.sessionManager.getBranch().some((entry) => entry.id === p.branchId)) &&
          Date.parse(p.expiresAt) > Date.now()
        )
          return true;
      }
    }
    return false;
  };
  const check = async (ctx, confirmed, approvedHash = null) => {
    await init(ctx);
    if (armed && (hash(current) !== armedContract || Date.now() > armedUntil)) armed = false;
    if (!current) throw Error(noTask(ctx));
    if (approvedHash && hash(current) !== approvedHash)
      throw Error('Contract changed during approval; confirm again');
    if (!ctx.isProjectTrusted()) throw Error('Project not trusted');
    if (busy) throw Error('Verification already running');
    busy = true;
    try {
      let state = await latest(ctx);
      if (state.status === 'needs_human_review' && !confirmed)
        throw Error('Human decision required');
      if (
        state.status === 'draft' ||
        ['accepted', 'rejected', 'needs_human_review'].includes(state.status)
      ) {
        state = transition(state, 'in_progress');
        state.attemptId = uid();
        markTask(current.id, state.attemptId);
        await save(ctx, state);
      }
      state = transition(state, 'candidate');
      await save(ctx, state);
      state = transition(state, 'verifying');
      await save(ctx, state);
      const result = await verify(current, rt.root, confirmed, false, {
        config: conf(),
        signal: ctx.signal,
        isApproved: approved,
        onReceipt: async (r) =>
          rt.store.append('gate-receipts', {
            ...r,
            ...scopeOf(ctx),
            taskId: current.id,
            attemptId: state.attemptId,
          }),
      });
      lastReport = result;
      state = { ...transition(state, result.status), report: result };
      await save(ctx, state);
      // `armScope: once` (or the panel's one-shot row) is spent by the verification it
      // authorized; anything else keeps its window until it expires.
      if (armOnce || conf().armScope === 'once') {
        armed = false;
        armOnce = false;
      }
      await rt.emit('gate.evaluated', {
        taskId: current.id,
        status: result.status,
        contractHash: result.contractHash,
        outOfScope: (result.outOfScope ?? []).map((r) => r.reasonCode ?? r.criterionId),
        passingCheckIds: result.receipts
          .filter((r) => r.status === 'pass')
          .map((r) => r.criterionId),
        evidenceIds: result.receipts.filter((r) => r.status === 'pass').map((r) => r.id),
        verified: true,
      });
      return result;
    } finally {
      busy = false;
    }
  };

  /* ------------------------------------------------------------------ *\n   Scope: the gate can only promise what this session can run. When it\n   cannot, ask, offer the cheapest fix, and never ask twice.\n   ------------------------------------------------------------------ */

  /** Hosts the selected contract's `api_contract` criteria would reach. */
  const contractHosts = () => {
    const hosts = new Set();
    for (const c of current?.acceptance ?? []) {
      if (c.type !== 'api_contract' || !c.url) continue;
      try {
        hosts.add(new URL(c.url).hostname);
      } catch {
        /* malformed url: the checker itself will report it */
      }
    }
    return [...hosts];
  };

  /** Executables the contract needs, cheapest criterion first, with the allowlist state. */
  const neededExecutables = (configuration = conf()) => {
    const rows = [];
    for (const c of byCost(current?.acceptance ?? [])) {
      if (
        !c.command ||
        ['human', 'human_review', 'git_diff', 'file', 'documentation'].includes(c.type)
      )
        continue;
      const parts = Array.isArray(c.command) ? c.command : words(c.command);
      const exe = String(parts[0] ?? '').replace(/^\.\//, '').replace(/\.cmd$/, '');
      if (!exe) continue;
      rows.push({
        exe,
        criterionId: c.id,
        cost: CHECKER_COST[c.type] ?? 5,
        allowed: (configuration.allowedExecutables ?? []).includes(exe),
      });
    }
    return rows;
  };

  /**
   * A checker the session cannot run is a question, not a verdict: name the real reason,
   * order the fix by what it costs *this* task, offer the cheapest one, and stop after a
   * refusal. Before 0.3 these three landed in the same anonymous `inconclusive`, so the
   * only advice available was "the checker failed".
   */
  const scopeAdvice = (report) => {
    const blocked = report?.outOfScope ?? [];
    return blocked.map((r) => {
      const code = r.reasonCode ?? 'capability-missing';
      const exe = neededExecutables().find((x) => x.criterionId === r.criterionId)?.exe;
      const fix = code.startsWith('host-not-allowlisted')
        ? `/gate allow host ${code.split(':')[1]}`
        : /-not-installed$/.test(code)
          ? `instale ${code.replace(/-not-installed$/, '')} · ou /gate scope declared para cobrar mesmo assim`
          : `/gate allow exe ${exe ?? '<exe>'}`;
      return { id: r.criterionId, code, fix };
    });
  };

  /**
   * Ask once, in the cheapest-first order, and remember the refusal (rule F). The
   * question is only asked when the blocker is something this project can decide —
   * an executable outside the allowlist. A binary that is not installed is the user's
   * to install, so the advice says so and nothing is written.
   */
  const askWidening = async (ctx, report) => {
    const lines = scopeAdvice(report).map((a) => `fora do escopo: ${a.id} (${a.code}) → ${a.fix}`);
    const blocked = report?.outOfScope ?? [];
    if (!blocked.length) return [];
    const cands = byCost(neededExecutables().filter((n) => !n.allowed));
    if (!cands.length || declinedWiden || !ctx.hasUI || typeof ctx.ui.confirm !== 'function')
      return lines;
    const c = cands[0];
    const agreed = await ctx.ui.confirm(
      'Checker fora do escopo desta sessão',
      `${c.criterionId} precisa de \`${c.exe}\`, que não está em acceptanceGate.allowedExecutables. Liberar é widening de segurança: escreve no arquivo deste projeto e o contrato passa a poder executar esse binário.`,
    );
    if (!agreed) {
      declinedWiden = true;
      lines.push(
        `recusado — não será perguntado de novo nesta sessão; ${c.criterionId} segue out-of-scope`,
      );
      return lines;
    }
    const file = await widen(ctx, 'exe', c.exe);
    lines.push(`▸ aplicado: ${c.exe} liberado em ${file}`);
    return lines;
  };

  /**
   * Widening writes the security surface of THIS project, never the global config: a
   * global allowlist would let one repo's contract run binaries in every other one.
   */
  const widen = async (ctx, kind, value) => {
    if (!ctx.isProjectTrusted())
      throw Error(
        `Widening exige projeto confiado: confie este repositório e repita /gate allow ${kind} ${value} (nada foi escrito).`,
      );
    const { patch } = applyField(conf(), WIDENING[kind], `add:${value}`, {
      locked: locked(),
      state: { contractHosts: contractHosts() },
    });
    return rt.save('acceptanceGate', patch, { global: false });
  };
  const narrow = async (ctx, kind, value) => {
    const { patch } = applyField(conf(), WIDENING[kind], `remove:${value}`, {
      locked: locked(),
      state: { contractHosts: contractHosts() },
    });
    return rt.save('acceptanceGate', patch, { global: false });
  };

  /** Ask which contract this session works on — once, and a refusal sticks. */
  const askContract = async (ctx) => {
    if (askedContract || !selection?.ask) return selection;
    askedContract = true;
    const rows = (selection.ranked?.scored ?? []).slice(0, 6);
    if (!rows.length || !ctx.hasUI || typeof ctx.ui.select !== 'function') return selection;
    const labels = rows.map((row, i) =>
      recommendedLabel(
        { id: row.taskId },
        i,
        `aderência ${row.score} · ${row.checkers} checker(s) · risco ${row.risk}${row.reasonCodes.length ? ` · ${row.reasonCodes.join(' ')}` : ''}`,
      ),
    );
    const chosen = await ctx.ui.select(
      `${tasks.length} contratos em .pi/tasks/ — em qual esta sessão trabalha?`,
      labels,
    );
    if (!chosen) return selection;
    const picked = tasks.find((t) => String(chosen).startsWith(t.id));
    if (picked) applyChoice(ctx, picked.id);
    return selection;
  };

  const applyChoice = (ctx, id) => {
    const picked = tasks.find((t) => t.id === id);
    if (!picked) return null;
    explicitId = picked.id;
    markTask(picked.id);
    current = picked;
    selection = {
      ...selection,
      contract: picked,
      mode: 'explicit',
      ask: false,
      reasonCodes: ['explicit-selection'],
      reason: `escolha explícita: /gate use ${picked.id}`,
    };
    announceNeeded = true;
    return picked;
  };

  /** No contract at all — the message the panel answers with a question, not a stack. */
  const noTask = (ctx) =>
    tasks.length
      ? `Nenhum contrato selecionado entre ${tasks.map((t) => t.id).join(', ')} — escolha: /gate use ${tasks[0].id}`
      : ctx?.hasUI
        ? 'Nenhum contrato em .pi/tasks/. Rode /gate (sem argumento) e o painel pergunta o que criar; sem interface, /gate init.'
        : 'Nenhum contrato em .pi/tasks/. Crie um com /gate init (escreve .pi/tasks/TASK-001.yaml com git_diff + node --test + review), edite os checkers e rode /gate check.';

  /** Guided creation, from the panel or from the rescue prompt. `persist: false` = session only. */
  const createContract = async (ctx, { id, title, risk, checkerIds, persist: keep = true, signal }) => {
    const throwIfAborted = () => {
      if (!signal?.aborted) return;
      const error = new Error('criação cancelada antes da gravação');
      error.name = 'AbortError';
      throw error;
    };
    throwIfAborted();
    const chosen = suggestCheckers({ nodeProject: true }).filter(
      (c) => !checkerIds || checkerIds.includes(c.id),
    );
    const document = {
      task: {
        id,
        title: title || `Acceptance for ${id}`,
        risk: RISK_ORDER.includes(risk) ? risk : 'moderate',
        acceptance: chosen.map(({ id: cid, type, command, allowedPaths, forbiddenPaths, required }) => ({
          id: cid,
          type,
          ...(command ? { command } : {}),
          ...(allowedPaths ? { allowedPaths } : {}),
          ...(forbiddenPaths ? { forbiddenPaths } : {}),
          required,
        })),
        maxAutoRevisions: 2,
      },
    };
    if (!keep) {
      // "só desta vez": the session works on it and no file is written.
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(id ?? '')))
        throw Error('ID inválido: use letras, números, _ ou - (ex.: /gate init TASK-002)');
      const task = validateContract(document);
      tasks = [...tasks, task];
      explicitId = task.id;
      current = task;
      selection = {
        contract: task,
        mode: 'explicit',
        ranked: selection?.ranked,
        ask: false,
        reasonCodes: ['session-only-contract'],
        reason: `contrato ${task.id} criado nesta sessão, sem escrever arquivo`,
      };
      announceNeeded = true;
      return { path: null, task };
    }
    if (!ctx.isProjectTrusted())
      throw Error(
        'O gate só escreve contratos em projeto confiado: confie este repositório e repita /gate init.',
      );
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(id ?? '')))
      throw Error('ID inválido: use letras, números, _ ou - (ex.: /gate init TASK-002)');
    throwIfAborted();
    const taskDir = join(rt.root, '.pi', 'tasks');
    const path = await safePath(rt.root, `.pi/tasks/${id}.yaml`);
    const tempPath = await safePath(rt.root, `.pi/tasks/.${id}.${randomUUID()}.tmp`);
    let createdTaskDir = false;
    let committed = false;
    try {
      try {
        await access(taskDir);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await mkdir(taskDir, { recursive: true });
        createdTaskDir = true;
      }
      throwIfAborted();
      const temp = await open(tempPath, 'wx', 0o600);
      try {
        await temp.writeFile(draftContract(document.task), { signal });
        throwIfAborted();
        // link() is an atomic create-if-absent commit: an existing contract is never
        // overwritten, and Escape before this point leaves no contract behind.
        await link(tempPath, path);
        committed = true;
      } finally {
        await temp.close();
        await unlink(tempPath).catch((error) => {
          if (error?.code !== 'ENOENT') throw error;
        });
      }
    } finally {
      if (createdTaskDir && !committed) {
        await rmdir(taskDir).catch((error) => {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error;
        });
      }
    }
    diffCache = { key: null, paths: diffCache.paths };
    tasks = await loadTasks(rt.root);
    applyChoice(ctx, id);
    return { path, task: current };
  };

  /** Bare `/gate` without contracts: ask and help instead of throwing. */
  const offerCreate = async (ctx) => {
    if (declinedCreate || !ctx.hasUI || typeof ctx.ui.confirm !== 'function') {
      if (declinedCreate)
        return output(ctx, 'ok — sem contrato o gate não verifica nada nesta sessão.');
      throw Error(noTask(ctx));
    }
    const agreed = await ctx.ui.confirm(
      'Nenhum contrato de aceite neste projeto',
      '.pi/tasks/ está vazio, então não há o que verificar. Criar um com os checkers mais baratos primeiro (git_diff de graça, node --test, review humano)?',
    );
    if (!agreed) {
      declinedCreate = true;
      return output(ctx, 'ok — nada foi escrito; o gate fica quieto até existir um contrato.');
    }
    const enteredId =
      typeof ctx.ui.input === 'function'
        ? await ctx.ui.input('ID do contrato', 'TASK-002')
        : undefined;
    // The host input returns an empty string when Esc cancels this quick prompt.
    // Treat that as cancellation; `|| 'TASK-002'` used to create a contract anyway.
    if (enteredId === undefined || enteredId === null || enteredId === '')
      return output(ctx, 'criação cancelada; nada foi salvo.');
    const id = enteredId;
    const chosenRisk =
      typeof ctx.ui.select === 'function'
        ? await ctx.ui.select('Risco do trabalho', RISK_ORDER)
        : undefined;
    // Select cancellation can also be represented by an empty value by host adapters.
    if (chosenRisk === undefined || chosenRisk === null || chosenRisk === '')
      return output(ctx, 'criação cancelada; nada foi salvo.');
    const risk = chosenRisk;
    const created = await createContract(ctx, { id, risk, persist: true });
    return output(
      ctx,
      `contrato ${id} criado · ${created.task.acceptance.length} checker(s) · salvo em ${created.path}\nPróximo passo: /gate check`,
    );
  };

  /* ------------------------------------------------------------------ *\n   The panel.\n   ------------------------------------------------------------------ */

  const cloneConfig = (value) => structuredClone(value ?? {});
  const replayDraft = (base, actions) => {
    let config = cloneConfig(base);
    let patch = {};
    for (const { id, value } of actions) {
      const applied = applyField(config, id, value, {
        locked: locked(),
        state: { contractHosts: contractHosts() },
      });
      patch = mergePatch(patch, applied.patch);
      config = mergePatch(config, applied.patch);
    }
    return { config, patch };
  };

  const menuState = () => {
    const cap = continuationCap(current?.maxAutoRevisions, conf().maxAutoRevisions);
    return {
      contract: current,
      mode: selection?.mode ?? 'none',
      reason: selection?.reason,
      reasonCodes: selection?.reasonCodes ?? [],
      checkers: current?.acceptance ?? [],
      outOfScope: (lastReport?.outOfScope ?? []).length,
      armed,
      armedUntil: armedUntil === Number.POSITIVE_INFINITY
        ? 'always'
        : armedUntil ? new Date(armedUntil).toISOString().slice(11, 16) : null,
      report: lastReport,
      ranked: selection?.ranked,
      contractHosts: contractHosts(),
      cap,
    };
  };

  const executablesRows = () => {
    const c = panelDraftConfig ?? conf();
    const needed = neededExecutables(c);
    const rows = [];
    for (const exe of c.allowedExecutables ?? [])
      rows.push({ value: `remove:${exe}`, label: `remover ${exe}`, description: 'liberado hoje' });
    const blocked = new Set(needed.filter((n) => !n.allowed).map((n) => n.exe));
    const rest = (FIELDS.allowedExecutables.candidates ?? []).filter(
      (x) => !(c.allowedExecutables ?? []).includes(x),
    );
    [...blocked, ...rest.filter((x) => !blocked.has(x))].forEach((exe, i) => {
      const why = needed.find((n) => n.exe === exe);
      rows.push({
        value: `add:${exe}`,
        label: `${i === 0 ? '▸ recomendado ' : ''}liberar ${exe}`,
        description: why
          ? `o checker ${why.criterionId} pede (custo ${why.cost}) · escreve no arquivo do projeto`
          : 'nada do contrato pede este binário agora',
      });
    });
    return rows;
  };

  const hostsRows = () => {
    const c = panelDraftConfig ?? conf();
    const rows = [];
    for (const host of c.allowedHosts ?? [])
      rows.push({ value: `remove:${host}`, label: `remover ${host}`, description: 'liberado hoje' });
    for (const host of contractHosts())
      if (!(c.allowedHosts ?? []).includes(host))
        rows.push({
          value: `add:${host}`,
          label: `▸ recomendado liberar ${host}`,
          description: 'o contrato chama este host e ele não está na allowlist',
        });
    if (!rows.length)
      rows.push({
        value: 'noop',
        label: 'nada a oferecer',
        description: 'nenhum host em .pi/tasks/ — use /gate allow host <host>',
      });
    return rows;
  };

  const armPanel = async (value) => {
    const action = armAction(value);
    if (!action)
      return `arm: ${value} não está na tabela · use ${ARM_ACTIONS.map((a) => a.value).join(' | ')}`;
    armed = true;
    armedContract = current ? hash(current) : null;
    if (action.scope === 'once') {
      armOnce = true;
      armedUntil = Number.POSITIVE_INFINITY;
      return 'armado só para esta verificação · nada foi escrito';
    }
    if (action.scope === 'always') {
      armedUntil = Number.POSITIVE_INFINITY;
      await rt.save('acceptanceGate', { armScope: 'always', autoVerifyOnCandidate: true });
      return 'armado sempre neste projeto · armScope: always + autoVerifyOnCandidate: true';
    }
    armedUntil = Date.now() + action.seconds * 1000;
    await rt.save('acceptanceGate', {
      armScope: 'ttl',
      approvalTtlSeconds: action.seconds,
    });
    return `armado por ${action.value.slice(4)} · approvalTtlSeconds: ${action.seconds}`;
  };

  const openMenu = async (ctx) => {
    await askContract(ctx);
    const projectTrusted = ctx.isProjectTrusted();
    const locale = await loadProjectLanguage(rt.root, projectTrusted);
    let savedLanguage = locale.language;
    let draftLanguage = savedLanguage;
    if (locale.warning)
      ctx.ui.notify(translateText('en', 'Idioma do projeto inválido; usando inglês.'), 'warning');
    let savedConfig = cloneConfig(conf());
    let draftConfig = cloneConfig(savedConfig);
    panelDraftConfig = draftConfig;
    let draftActions = [];
    const isDirty = () => !isDeepStrictEqual(draftConfig, savedConfig);
    const updateDraft = (id, value, update) => {
      const actions = [...draftActions, { id, value }];
      const rebuilt = replayDraft(savedConfig, actions);
      if (isDeepStrictEqual(rebuilt.config, savedConfig)) {
        draftActions = [];
        draftConfig = cloneConfig(savedConfig);
      } else {
        draftActions = actions;
        draftConfig = rebuilt.config;
      }
      panelDraftConfig = draftConfig;
      const row = items.find((item) => item.id === id);
      if (row && FIELDS[id]?.kind === 'list') update?.(id, FIELDS[id].current(draftConfig));
      return FIELDS[id].note(value, draftConfig);
    };
    const rebaseDraft = (update) => {
      savedConfig = cloneConfig(conf());
      try {
        draftConfig = replayDraft(savedConfig, draftActions).config;
      } catch {
        // Keep the visible draft; Ctrl+S will show the precise validation/lock error.
      }
      panelDraftConfig = draftConfig;
      for (const [id, field] of Object.entries(FIELDS)) update?.(id, field.current(draftConfig));
    };
    const c = draftConfig;
    const state = menuState();
    const items = panelItems({ conf: c, locked: locked(), state, language: draftLanguage, languageEnabled: projectTrusted });
    const refreshPanelRows = () => {
      const fresh = panelItems({
        conf: draftConfig,
        locked: locked(),
        state: menuState(),
        language: draftLanguage,
        languageEnabled: projectTrusted,
      });
      for (const replacement of fresh) {
        const row = items.find((item) => item.id === replacement.id);
        if (!row) continue;
        const submenu = row.submenu;
        Object.assign(row, replacement);
        if (typeof submenu === 'function') row.submenu = submenu;
      }
    };
    const menus = {
      contracts: () =>
        (state.ranked?.scored ?? []).map((row, i) => ({
          value: row.taskId,
          label: `${i === 0 ? '▸ recomendado ' : ''}${row.taskId}`,
          description: `aderência ${row.score} · ${row.checkers} checker(s) · risco ${row.risk}${row.reasonCodes.length ? ` · ${row.reasonCodes.join(' ')}` : ''}`,
        })),
      checkers: () => checkerLines(current, lastReport, draftConfig),
      report: () => reportLines(lastReport, current),
      help: () => {
        const localizedSpec = {
          ...gateSpec,
          actions: Object.fromEntries(Object.entries(gateSpec.actions).map(([action, spec]) => [action, {
            ...spec,
            description: translateText(draftLanguage, spec.description ?? ''),
            args: spec.args?.map((arg) => ({
              ...arg,
              hint: translateText(draftLanguage, arg.hint ?? ''),
            })),
          }])),
        };
        if (draftLanguage === 'en') {
          localizedSpec.actions.scope.description = translateText('en', 'available = só o que a sessão executa · declared = tudo do contrato');
          localizedSpec.actions.allow.description = translateText('en', 'widening de segurança, com confirmação, no arquivo do projeto');
          localizedSpec.actions.deny.description = translateText('en', 'tirar da allowlist');
          localizedSpec.actions.on.description = translateText('en', 'ligar o gate (acceptanceGate.enabled: true)');
          localizedSpec.actions.off.description = translateText('en', 'desligar o gate nesta sessão e no arquivo');
        }
        return usageText('gate', localizedSpec).split('\n');
      },
      arm: () => armRows(draftConfig, menuState()),
      executables: () => executablesRows(),
      hosts: () => hostsRows(),
      create: (id, { signal } = {}) =>
        createContract(ctx, { id, persist: true, signal }).then((r) => {
          // The screen was built from the state at open time; a contract created here
          // has to move the rows it changed, or the panel keeps saying "nenhum" next to
          // a file it wrote a second ago.
          const row = items.find((i) => i.id === 'contract');
          if (row) row.currentValue = r.task.id;
          const checkers = items.find((i) => i.id === 'checkers');
          if (checkers) checkers.currentValue = `${r.task.acceptance.length} · 0 fora do escopo`;
          ctx.ui.notify(`contrato ${r.task.id} criado · salvo em ${r.path}`, 'info');
          return `criado ${r.task.id} · ${r.task.acceptance.length} checker(s) · salvo em ${r.path}`;
        }),
    };
    const onChange = (id, value, update) => {
      if (id === 'uiLanguage') {
        draftLanguage = value;
        refreshPanelRows();
        update?.('uiLanguage', languageName(value));
        return `Rascunho do idioma: ${languageName(value)}. Ctrl+S salva a alteração.`;
      }
      if (id === 'contract') {
        const picked = applyChoice(ctx, value);
        return picked
          ? `contrato → ${picked.id} · escolha explícita (só esta sessão)`
          : `contrato ${value} não existe mais`;
      }
      if (id === 'arm')
        return Promise.resolve(armPanel(value)).then((note) => {
          rebaseDraft(update);
          // The row says what it now *is*, not just the label that was clicked: the
          // host overwrites the row value with the pick, and a stale "desarmado" would
          // read as a failed authorization.
          if (armed && update)
            update(
              'arm',
              armedUntil === Number.POSITIVE_INFINITY
                ? `armado · ${value}`
                : `armado até ${new Date(armedUntil).toISOString().slice(11, 16)}`,
            );
          return note;
        });
      if (id === 'allowedExecutables' || id === 'allowedHosts') {
        const kind = id === 'allowedHosts' ? 'host' : 'exe';
        if (String(value).startsWith('remove:')) return updateDraft(id, value, update);
        const target = value.slice(4);
        // Widening a security allowlist is two deliberate acts on the same row, not a
        // slip of the enter key: the first one only says what it would do.
        if (pendingWidening !== value) {
          pendingWidening = value;
          update?.(id, FIELDS[id].current(draftConfig));
          return Promise.resolve(
            `⚠ ${target} NADA foi escrito — isto libera ${kind.toUpperCase()} para contratos deste projeto; escolha a mesma linha de novo para confirmar`,
          );
        }
        pendingWidening = null;
        return updateDraft(id, value, update);
      }
      if (id === 'noop') return Promise.resolve('nada a fazer aqui');
      return updateDraft(id, value, update);
    };
    const opened = await runDashboard({
      ctx,
      title: panelTitle(c, state, draftLanguage),
      getTitle: () => panelTitle(draftConfig, menuState(), draftLanguage),
      getLanguage: () => draftLanguage,
      onLanguageChange: refreshPanelRows,
      items,
      onChange,
      menus,
      isDirty: () => isDirty() || draftLanguage !== savedLanguage,
      isDraftChange: (id) => Boolean(FIELDS[id]) || id === 'uiLanguage',
      onSave: async () => {
        const notes = [];
        const rebuilt = replayDraft(savedConfig, draftActions);
        if (!isDeepStrictEqual(rebuilt.config, savedConfig)) {
          const path = await rt.save('acceptanceGate', rebuilt.patch, { global: false });
          savedConfig = cloneConfig(conf());
          draftConfig = cloneConfig(savedConfig);
          draftActions = [];
          panelDraftConfig = draftConfig;
          refreshPanelRows();
          notes.push(`Configuração validada e salva em ${path}; já em efeito.`);
        } else {
          draftActions = [];
          draftConfig = cloneConfig(savedConfig);
          panelDraftConfig = draftConfig;
        }
        if (draftLanguage !== savedLanguage) {
          await saveProjectLanguage(rt.root, projectTrusted, draftLanguage);
          savedLanguage = draftLanguage;
          notes.push(`Idioma salvo para este projeto: ${languageName(savedLanguage)}.`);
        }
        refreshPanelRows();
        if (!notes.length) return translateText(draftLanguage, 'Nenhuma alteração de configuração pendente.');
        return notes.join('\n');
      },
      onDiscard: (update) => {
        draftActions = [];
        draftConfig = cloneConfig(savedConfig);
        panelDraftConfig = draftConfig;
        draftLanguage = savedLanguage;
        refreshPanelRows();
        for (const [id, field] of Object.entries(FIELDS)) update(id, field.current(draftConfig));
        update?.('uiLanguage', languageName(draftLanguage));
      },
    });
    if (opened === false) return fallbackPanel(ctx, state, draftLanguage);
    const changed = opened?.changed ?? [];
    panelDraftConfig = null;
    return output(
      ctx,
      translateText(savedLanguage, opened?.discarded
        ? 'Gate · rascunho descartado; nenhuma configuração pendente foi salva.'
        : changed.length
        ? `Gate · ${changed.length} mudança(s)\n${changed.map((x) => `· ${x}`).join('\n')}\nsalvo em ${rt.configFile}`
        : 'Gate · nada foi alterado no painel.'),
    );
  };

  /**
   * No custom screen available: state first, then the two or three lines that act on
   * it. Never a grammar dump as the answer, and never a silent "nothing happened".
   */
  const fallbackPanel = (ctx, state, language = 'en') => {
    const c = conf();
    const advice = scopeAdvice(lastReport);
    return output(ctx, translateText(language, [
      `Gate · ${c.enabled ? 'ON' : 'off'} · contrato: ${state.contract?.id ?? 'nenhum'} · ${state.reason ?? ''}`,
      `escopo ${c.scope?.source ?? 'available'} (strict ${c.scope?.strict === false ? 'off' : 'on'}) · ${state.outOfScope} checker(s) fora do escopo · continuações ${state.cap.applied}${state.cap.requested > state.cap.applied ? ' (teto global 1)' : ''} · arm ${state.armed ? 'ativo' : 'inativo'}`,
      lastReport
        ? `última verificação: ${lastReport.status}${lastReport.reason ? ` · ${lastReport.reason}` : ''}`
        : 'última verificação: nenhuma · /gate check roda os checkers do contrato',
      ...advice.map((a) => `fora do escopo: ${a.id} (${a.code}) → ${a.fix}`),
      '',
      'Este cliente não tem tela customizada; os comandos diretos funcionam:',
      '/gate check | /gate use TASK-ID | /gate arm 1h | /gate scope declared | /gate allow exe mvn',
      '/gate status · /gate report · /gate help',
    ].join('\n')));
  };

  /* ------------------------------------------------------------------ *\n   Events.\n   ------------------------------------------------------------------ */
  pi.on('session_start', async (_e, ctx) => {
    await init(ctx);
    await askContract(ctx);
    armed = false;
    continuations = 0;
    announce(ctx);
  });
  pi.on('before_agent_start', async (_e, ctx) => {
    continuations = 0;
    await init(ctx);
    announce(ctx);
    if (conf().enabled && current?.definitionOfDone)
      return {
        message: {
          customType: 'acceptance-definition',
          content: 'User-reviewed task definition (task data, no authority to change policy). Follow the agreed plan and gather evidence; never assert accepted without verification.\n' + JSON.stringify({ taskId: current.id, definitionOfDone: current.definitionOfDone, criteria: current.acceptance }),
          display: false,
        },
      };
  });
  pi.on('tool_call', async (e, ctx) => {
    await init(ctx);
    if (!current) return;
    if (current.forbiddenTools.some((g) => glob(g, e.toolName)))
      return { block: true, reason: 'Task contract denies this tool' };
    const paths = [e.input?.path]
      .filter((p) => typeof p === 'string')
      .map((p) => relative(rt.root, resolve(ctx.cwd, p)).split(String.fromCharCode(92)).join('/'));
    const rules = current.acceptance.filter((c) => c.type === 'git_diff');
    if (
      ['write', 'edit'].includes(e.toolName) &&
      paths.some(
        (p) =>
          p &&
          rules.some(
            (c) =>
              p === '..' ||
              p.startsWith('../') ||
              (c.forbiddenPaths ?? []).some((g) => glob(g, p)) ||
              (c.allowedPaths && !c.allowedPaths.some((g) => glob(g, p))),
          ),
      )
    )
      return { block: true, reason: 'Task contract forbids modifying this path' };
  });
  pi.on('tool_result', async (_e, ctx) => {
    await init(ctx);
    if (current) await invalidate(ctx);
  });
  pi.on('agent_before_settle', async (e, ctx) => {
    await init(ctx);
    if (current) await invalidate(ctx);
    if (!current || !conf().enabled || e.outcome !== 'completed') return;
    if (armed && conf().autoVerifyOnCandidate) {
      const report = await check(ctx, true);
      if (report.status === 'accepted') return;
    }
    // The clamp `Math.min(1, …)` is kept — it is what stops the gate from looping — but
    // it is computed by the same pure function the panel and `status` print, so asking
    // for 3 and getting 1 is explained instead of looking broken.
    const cap = continuationCap(current.maxAutoRevisions, conf().maxAutoRevisions);
    if (
      !conf().continueForPendingChecks ||
      continuations >= cap.applied ||
      !e.context?.canContinue ||
      e.continue === true ||
      await longrunOwnsContinuation(pi, rt.projectId, ctx.sessionManager.getSessionId())
    )
      return;
    const s = await latest(ctx);
    if (s.status === 'accepted' || s.status === 'needs_human_review') return;
    continuations++;
    await rt.emit('gate.revision_requested', {
      taskId: current.id,
      revision: continuations,
      cap: cap.applied,
      reasonCodes: cap.reasonCodes,
    });
    return {
      continue: true,
      entries: [
        ...e.entries,
        {
          type: 'custom_message',
          customType: 'gate-pending',
          content:
            'Acceptance is not verified. Use gate_check if authorized; otherwise report pending checks and stop. Do not assert accepted.',
          display: false,
        },
      ],
    };
  });
  pi.on('agent_settled', async (_e, ctx) => {
    await init(ctx);
    if (!current) {
      ctx.ui.setStatus('gate', 'gate · sem contrato');
      return;
    }
    await invalidate(ctx);
    const s = await latest(ctx);
    const cap = continuationCap(current.maxAutoRevisions, conf().maxAutoRevisions);
    ctx.ui.setStatus(
      'gate',
      `gate · ${s.status} · ${current.id} · cont ${cap.applied}${cap.requested > cap.applied ? ' (teto)' : ''}`,
    );
  });
  pi.on('session_shutdown', async () => {
    await rt.dispose();
  });

  if (Type)
    pi.registerTool({
      name: 'gate_check',
      label: 'Acceptance checks',
      description:
        'Run current task checkers with existing user authorization; returns actual evidence.',
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _update, ctx) {
        await init(ctx);
        const approvedHash = hash(current);
        const confirmed =
          armed ||
          (await rt.confirm(
            ctx,
            'Run acceptance checkers?',
            JSON.stringify(current?.acceptance ?? []),
          ));
        if (!confirmed) throw Error('No user authorization');
        const report = await check(ctx, true, approvedHash);
        return {
          content: [{ type: 'text', text: JSON.stringify(report) }],
          details: report,
          isError: report.status !== 'accepted',
        };
      },
    });

  const gateSpec = {
    name: 'gate',
    description: 'Evidence-based acceptance for the current task',
    actions: {
      create: { hint: '', description: 'define ready through questions, templates and an optional model' },
      templates: { hint: '', description: 'list the bundled public acceptance templates' },
      status: { hint: '', description: 'state, coverage and whether evidence is stale' },
      use: {
        hint: 'TASK-ID',
        description: 'select the contract this session works on',
        args: [
          {
            provide: async () =>
              tasks.map((t) => ({
                value: t.id,
                label: t.id,
                description: `${t.risk ?? 'risk?'} · ${(t.acceptance ?? []).length} checker(s)${current?.id === t.id ? ' · selected' : ''}`,
              })),
            hint: 'task id',
          },
        ],
      },
      init: {
        hint: '[TASK-ID]',
        description: 'write a starter contract into .pi/tasks/<ID>.yaml',
        args: [{ hint: 'task id' }],
      },
      check: { hint: '', description: 'run the contract checkers (confirmed)' },
      report: { hint: '', description: 'receipts for the latest attempt' },
      approve: {
        hint: 'JUSTIFICATION',
        description: 'human acceptance, tied to this exact snapshot',
        args: [{ hint: 'why you accept this' }],
        free: true,
      },
      fail: {
        hint: 'REASON',
        description: 'reject with a reason',
        args: [{ hint: 'what is wrong' }],
        free: true,
      },
      arm: {
        hint: '[once|15min|1h|8h|always]',
        description: 'authorize automatic verification (ttl persists, once does not)',
        args: [{ values: ARM_ACTIONS.map((a) => ({ value: a.value })), hint: 'alcance' }],
      },
      'arm-off': { hint: '', description: 'revoke the automatic-verification authorization' },
      scope: {
        hint: 'SCOPE',
        description: 'available = só o que a sessão executa · declared = tudo do contrato',
        args: [{ values: FIELDS.scopeSource.values.map((v) => ({ value: v })), hint: 'source' }],
      },
      'allow': {
        hint: 'exe|host VALOR',
        description: 'widening de segurança, com confirmação, no arquivo do projeto',
        args: [
          { values: [{ value: 'exe' }, { value: 'host' }], hint: 'kind', advance: true },
          {
            provide: async () => [
              ...neededExecutables()
                .filter((n) => !n.allowed)
                .map((n) => ({
                  value: n.exe,
                  description: `libera ${n.exe} para o checker ${n.criterionId}`,
                })),
              ...contractHosts().map((h) => ({ value: h, description: `libera ${h}` })),
            ],
            hint: 'valor',
          },
        ],
      },
      deny: {
        hint: 'exe|host VALOR',
        description: 'tirar da allowlist',
        args: [
          { values: [{ value: 'exe' }, { value: 'host' }], hint: 'kind', advance: true },
          {
            provide: async () => [
              ...(conf().allowedExecutables ?? []).map((v) => ({ value: v })),
              ...(conf().allowedHosts ?? []).map((v) => ({ value: v })),
            ],
            hint: 'valor',
          },
        ],
      },
      help: { hint: '', description: 'show this list' },
    },
  };
  for (const [action, field] of Object.entries(FIELD_ACTIONS))
    gateSpec.actions[action] = {
      hint: 'VALOR',
      description: FIELDS[field].hint,
      args: [{ values: fieldValues(field, gateDefaults.acceptanceGate).map((v) => ({ value: v })), hint: field }],
    };
  gateSpec.actions.on = { hint: '', description: 'ligar o gate (acceptanceGate.enabled: true)' };
  gateSpec.actions.off = { hint: '', description: 'desligar o gate nesta sessão e no arquivo' };

  /* ------------------------------------------------------------------ *\n   The one writer for the text-command path: same table, same lock,\n   same validation. `persist:false` (panel quiet mode) returns the note.\n   ------------------------------------------------------------------ */
  const setField = async (ctx, id, value, { quiet = false } = {}) => {
    const { patch, note } = applyField(conf(), id, value, {
      locked: locked(),
      state: { contractHosts: contractHosts() },
    });
    if (quiet) return rt.save('acceptanceGate', patch).then(() => note);
    const written = await rt.save('acceptanceGate', patch);
    // `rt.save` merges the patch into the live config as it writes, so the change is
    // already in effect: telling the user to `/reload` would teach them to distrust a
    // command that had just worked.
    output(ctx, `${note}\nsalvo em ${written} · já em efeito`, 'info');
    return note;
  };

  const gateCommand = {
    description:
      'Acceptance — (vazio abre o painel) | status | use ID | init | check | report | approve | fail | arm | scope | allow | deny | help',
    getArgumentCompletions: buildCompletions(gateSpec),
    handler: async (args, ctx) => {
      await init(ctx);
      const argv = words(args);
      // An empty argument list is the panel. A command with arguments keeps the old
      // behaviour, through the same table the panel writes with.
      if (!argv.length) {
        if (!ctx.hasUI) throw Error(noTask(ctx));
        return openMenu(ctx);
      }
      const [action = 'status', ...rest] = argv;
      if (action === 'help') return output(ctx, usageText('gate', gateSpec));
      if (busy && !['status', 'report'].includes(action))
        throw Error('Wait for the current verification to finish');
      if (action === 'templates')
        return output(ctx, templates.map((t) => t.id + ' · ' + t.label + ' · ' + t.description).join('\n'));
      if (action === 'create') {
        if (rest.length) throw Error('Use /acceptance create sem argumentos para abrir o diálogo.');
        const created = await createAcceptance(ctx, {
          root: rt.root,
          config: conf(),
          selectTask: async (task) => {
            tasks = await loadTasks(rt.root);
            if (!applyChoice(ctx, task.id)) {
              current = task;
              armed = false;
              ctx.ui.notify('Task ' + task.id + ' criada. Use /gate use ' + task.id + ' se não ficar selecionada.', 'warning');
            }
          },
        });
        return output(ctx, created);
      }
      if (action === 'init') {
        if (!ctx.isProjectTrusted())
          throw Error(
            'Project trust is required before the gate writes contracts into this repository.',
          );
        const id = rest[0] ?? 'TASK-001';
        const created = await createContract(ctx, { id, persist: true });
        return output(
          ctx,
          `contrato ${id} criado · ${created.task.acceptance.length} checker(s) · salvo em ${created.path}\nAjuste os checkers nesse arquivo (revisável em git) e rode /gate check`,
        );
      }
      if (action === 'use') {
        if (!rest[0])
          throw Error(
            tasks.length
              ? `use needs a TASK-ID. Contracts: ${tasks.map((t) => t.id).join(', ')}`
              : ctx.isProjectTrusted()
                ? 'use needs a TASK-ID, mas .pi/tasks/ está vazio. Abra /gate (painel) para criar um, ou rode /gate init.'
                : 'Nenhum contrato visível porque o projeto não é confiado, então .pi/tasks/ não é lido. Confie o projeto e rode /gate init.',
          );
        const picked = applyChoice(ctx, rest[0]);
        if (!picked)
          throw Error(
            `Unknown task "${rest[0]}". Contracts in .pi/tasks: ${tasks.map((t) => t.id).join(', ') || 'none — run /gate init'}`,
          );
        return output(ctx, { taskId: picked.id, mode: 'explicit', reason: 'você escolheu' });
      }
      if (action === 'on') return setField(ctx, 'enabled', 'on');
      if (action === 'off') return setField(ctx, 'enabled', 'off');
      if (FIELD_ACTIONS[action]) return setField(ctx, FIELD_ACTIONS[action], rest[0]);
      if (action === 'allow' || action === 'deny') {
        const kind = rest[0];
        const value = rest[1];
        if (!WIDENING[kind] || !value)
          throw Error(
            `Uso: /gate ${action} ${Object.keys(WIDENING).join('|')} <valor>. Ex.: /gate ${action} exe mvn`,
          );
        if (action === 'deny')
          return narrow(ctx, kind, value).then((f) =>
            output(ctx, `${value} saiu da allowlist · salvo em ${f} · já em efeito`),
          );
        const preview = `Isto libera ${kind === 'exe' ? `o binário \`${value}\`` : `o host \`${value}\``} para os checkers deste projeto. Escrita em ${rt.configFile} (arquivo do projeto, nunca no global).`;
        if (!(await rt.confirm(ctx, 'Confirmar widening de segurança?', preview)))
          throw Error(
            `Widening exige confirmação explícita — nada foi escrito. Repita: /gate allow ${kind} ${value}`,
          );
        return widen(ctx, kind, value).then((f) =>
          output(ctx, `⚠ ${value} liberado (${kind}) · salvo em ${f} · já em efeito`),
        );
      }
      if (!current) {
        // `status` is the command that answers "what is the gate doing?" — it answers
        // even when the answer is "nothing, and here is why". Only the commands that
        // would *act* on a missing contract refuse, and they refuse with a choice.
        if (action === 'status' || action === 'report')
          return output(ctx, noContractStatus(action));
        // With contracts on disk the answer is the list to choose from; with none, the
        // panel asks and helps, instead of throwing `Error('No contracts found…')`.
        if (!tasks.length && ctx.hasUI && ['check', 'arm'].includes(action)) return offerCreate(ctx);
        throw Error(noTask(ctx));
      }
      if (action === 'approve' && !rest.join(' ').trim())
        throw Error(
          'approve needs a justification — a human reason is the record, not a checkbox. Example: /gate approve tests cover the fix and diff is scoped to src/auth',
        );
      if (action === 'check') {
        const approvedHash = hash(current);
        if (!(await rt.confirm(ctx, 'Run task checkers?', JSON.stringify(current.acceptance))))
          throw Error(
            `Approval required; use CLI --approve in CI, or /gate arm ttl to authorize this contract for a window`,
          );
        const report = await check(ctx, true, approvedHash);
        const rescue = await askWidening(ctx, report);
        return output(ctx, [await reportText(ctx, report), ...rescue].join('\n'));
      }
      if (action === 'arm') {
        const choice = rest[0] ?? (conf().armScope === 'ttl' ? 'ttl' : conf().armScope ?? 'ttl');
        if (!armAction(choice))
          throw Error(
            `Invalid arm scope: ${choice}\nUse: ${ARM_ACTIONS.map((t) => t.value).join(' | ')}`,
          );
        if (
          !(await rt.confirm(
            ctx,
            'Authorize automatic verification?',
            `${current.title} · ${choice} · ${JSON.stringify(current.acceptance)}`,
          ))
        )
          throw Error(`Não autorizado — nada mudou. Repita: /gate arm ${choice}`);
        const note = await armPanel(choice);
        await rt.emit('gate.verification_authorized', {
          taskId: current.id,
          armed: true,
          scope: choice,
        });
        return output(ctx, `${note}\ncontrato: ${current.id} · ${selection?.reason ?? ''}`);
      }
      if (action === 'arm-off') {
        armed = false;
        await rt.emit('gate.verification_revoked', { taskId: current.id });
        return output(ctx, `arm revogado · ${current.id} · verificação volta a pedir confirmação`);
      }
      if (action === 'approve') {
        const snap = await snapshot(rt.root, {
          ignorePaths: evidenceIgnore(current, conf()),
        });
        const reason = rest.join(' ');
        if (!reason) throw Error('Approval requires justification');
        if (
          !(await rt.confirm(
            ctx,
            'Human review of current snapshot?',
            `${current.title}\n${reason}`,
          ))
        )
          throw Error('Human approval required');
        for (const c of current.acceptance.filter((c) =>
          ['human', 'human_review'].includes(c.type),
        )) {
          const signed = await rt.store.sign({
            ...scopeOf(ctx),
            taskId: current.id,
            criterionId: c.id,
            contractHash: hash(current),
            ...snap,
            files: undefined,
            actor: actor(),
            reason,
            approvedAt: now(),
            expiresAt: new Date(Date.now() + conf().approvalTtlSeconds * 1000).toISOString(),
          });
          await rt.store.append('approvals', { id: uid(), signed });
        }
        await rt.emit('gate.human_approved', { taskId: current.id, actor: actor(), reason });
        return output(ctx, { approved: true, next: 'Run /gate check' });
      }
      if (action === 'fail') {
        await save(ctx, {
          status: 'rejected',
          reason: rest.join(' ') || 'User rejected',
          attemptId: scopeOf(ctx).attemptId,
        });
        return output(ctx, { status: 'rejected' });
      }
      if (action === 'status' || action === 'report') {
        const s = await latest(ctx);
        const report = s.report ?? (action === 'report' ? lastReport : null) ?? null;
        return output(ctx, await statusText(ctx, action, s));
      }
      throw Error('Unknown /gate ' + action + '\n' + usageText('gate', gateSpec));
    },
  };
  pi.registerCommand('gate', gateCommand);
  pi.registerCommand('acceptance', {
    ...gateCommand,
    description: 'Acceptance — create | templates | status | use ID | check | help',
  });

  /** Status text: state first, and always the reason for the contract that was picked. */
  const statusText = async (ctx, action, s) => {
    const snap = await snapshot(rt.root, {
      ignorePaths: evidenceIgnore(current, conf()),
    }).catch(() => null);
    const report = s.report ?? lastReport;
    const stale =
      snap &&
      report &&
      (report.snapshot.workingTreeHash !== snap.workingTreeHash ||
        report.snapshot.commitHash !== snap.commitHash ||
        report.contractHash !== hash(current));
    const receipts = report?.receipts ?? [];
    const cap = continuationCap(current.maxAutoRevisions, conf().maxAutoRevisions);
    const lines = [
      `gate · contrato: ${current.id} · ${selection?.reason ?? 'sem explicação'}`,
      `${stale ? 'stale' : (s.status ?? 'draft')} · ${receipts.length} receipt(s) · escopo ${conf().scope?.source ?? 'available'} (strict ${conf().scope?.strict === false ? 'off' : 'on'})`,
      `continuações: ${cap.applied}${cap.requested > cap.applied ? ` (pedido ${cap.requested}, teto global 1)` : ''} · arm: ${armed ? 'ativo' : 'inativo'} · autoVerify: ${conf().autoVerifyOnCandidate ? 'on' : 'off'}`,
      ...receipts.map(
        (r) =>
          `  ${r.outOfScope ? 'out-of-scope' : (r.status ?? '?')}  ${r.id ?? r.criterionId ?? '?'}${r.required === false ? ' (optional)' : ''}${r.reasonCode ? ` — ${r.reasonCode}` : ''}`,
      ),
    ];
    if (action === 'report')
      lines.push(
        `history: ${(await rt.store.rows('tasks')).filter((r) => r.entityId === entity(ctx)).length} attempt(s) recorded`,
        JSON.stringify(report ?? null),
      );
    const advice = scopeAdvice(report);
    lines.push(
      ...(stale
        ? ['Evidence is stale (code, contract or commit changed). Run /gate check.']
        : !receipts.length
          ? ['Nothing verified yet. Run /gate check.']
          : s.status === 'accepted'
            ? ['Accepted for this snapshot.']
            : advice.map((a) => `fora do escopo: ${a.id} (${a.code}) → ${a.fix}`)),
    );
    return lines.join('\n');
  };

  /** State, honestly, when there is nothing selected — never a bare error. */
  const noContractStatus = (action) => {
    const c = conf();
    const cap = continuationCap(c.maxAutoRevisions, c.maxAutoRevisions);
    const lines = [
      `gate · contrato: nenhum · ${selection?.reason ?? 'sem decisão registrada'}`,
      `escopo ${c.scope?.source ?? 'available'} (strict ${c.scope?.strict === false ? 'off' : 'on'}) · continuações ${cap.applied}${cap.requested > cap.applied ? ' (pedido ' + cap.requested + ', teto global 1)' : ''} · arm inativo`,
    ];
    if (tasks.length)
      lines.push(
        `opções: ${(selection?.ranked?.scored ?? tasks.map((x) => ({ taskId: x.id, score: 0 })))
          .slice(0, 5)
          .map((r, i) => `${i === 0 ? '▸ ' : ''}${r.taskId}`)
          .join(', ')} · escolha com /gate use <ID> ou abra /gate`,
      );
    else
      lines.push('nenhum contrato em .pi/tasks/ · /gate init escreve um pronto para editar');
    if (action === 'report') lines.push('nenhuma verificação registrada nesta sessão');
    return lines.join('\n');
  };

  /** Report text after a run, leading with the reason the verdict has. */
  const reportText = async (_ctx, report) => {
    const advice = scopeAdvice(report);
    const lines = [
      `veredito: ${report.status}${report.reason ? ` · ${report.reason}` : ''}`,
      `contrato: ${report.taskId} · verificador ${VERIFIER_VERSION} · escopo ${report.scope?.source} (strict ${report.scope?.strict === false ? 'off' : 'on'}${report.scope?.relaxed ? ', relaxado' : ''})`,
      ...advice.map((a) => `fora do escopo: ${a.id} (${a.code}) → ${a.fix}`),
      ...(report.outOfScope?.length && report.scope?.strict !== false
        ? ['com strict on o veredito é o mesmo de antes: muda o motivo, não o resultado']
        : []),
      'próximo passo: ' +
        (report.status === 'accepted'
          ? 'nada a fazer para este snapshot'
          : report.status === 'needs_human_review'
            ? '/gate approve <justificativa>'
            : 'corrija e /gate check'),
    ];
    return lines.join('\n');
  };
}
