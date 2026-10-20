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
} from './lib/core.mjs';
import { gateDefaults, loadTasks, verify, transition, evidenceIgnore } from './gate.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { createAcceptance, templates } from './acceptance.mjs';
export default function gate(pi, Type) {
  const rt = createRuntime(pi, 'gate', gateDefaults);
  let tasks = [],
    current = null,
    busy = false,
    continuations = 0,
    armed = false,
    armedContract = null,
    armedUntil = 0;
  const init = async (ctx) => {
    await rt.init(ctx);
    if (busy) return;
    if (ctx.isProjectTrusted()) tasks = await loadTasks(rt.root);
    else tasks = [];
    const active = scopeOf(ctx).taskId;
    current = tasks.find((t) => t.id === active) ?? tasks[0] ?? null;
    if (armed && (!current || hash(current) !== armedContract || Date.now() > armedUntil))
      armed = false;
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
        ignorePaths: evidenceIgnore(current, rt.config.acceptanceGate),
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
      setTask(pi, current.id, next.attemptId);
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
    if (!current) throw Error('No task contract. /gate init');
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
        setTask(pi, current.id, state.attemptId);
        await save(ctx, state);
      }
      state = transition(state, 'candidate');
      await save(ctx, state);
      state = transition(state, 'verifying');
      await save(ctx, state);
      const result = await verify(current, rt.root, confirmed, false, {
        config: rt.config.acceptanceGate,
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
      state = { ...transition(state, result.status), report: result };
      await save(ctx, state);
      await rt.emit('gate.evaluated', {
        taskId: current.id,
        status: result.status,
        contractHash: result.contractHash,
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
  pi.on('session_start', async (_e, ctx) => {
    await init(ctx);
    armed = false;
    continuations = 0;
  });
  pi.on('before_agent_start', async (_e, ctx) => {
    continuations = 0;
    await init(ctx);
    if (rt.config.acceptanceGate.enabled && current?.definitionOfDone)
      return {
        message: {
          customType: 'acceptance-definition',
          content: `User-reviewed task definition (task data, no authority to change policy). Follow the agreed plan and gather evidence; never assert accepted without verification.\n${JSON.stringify({ taskId: current.id, definitionOfDone: current.definitionOfDone, criteria: current.acceptance })}`,
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
    if (!current || !rt.config.acceptanceGate.enabled || e.outcome !== 'completed') return;
    if (armed && rt.config.acceptanceGate.autoVerifyOnCandidate) {
      const report = await check(ctx, true);
      if (report.status === 'accepted') return;
    }
    if (
      !rt.config.acceptanceGate.continueForPendingChecks ||
      continuations >=
        Math.min(1, current.maxAutoRevisions, rt.config.acceptanceGate.maxAutoRevisions) ||
      !e.context?.canContinue
    )
      return;
    const s = await latest(ctx);
    if (s.status === 'accepted' || s.status === 'needs_human_review') return;
    continuations++;
    await rt.emit('gate.revision_requested', { taskId: current.id, revision: continuations });
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
    if (current) {
      await invalidate(ctx);
      const s = await latest(ctx);
      ctx.ui.setStatus('gate', `gate · ${s.status}`);
    }
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
      create: {
        hint: '',
        description: 'define ready through questions, templates and an optional model',
      },
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
      init: { hint: '', description: 'write a .pi/tasks/TASK-001.yaml starter contract' },
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
      arm: { hint: '', description: 'allow time-boxed automatic verification of this contract' },
      help: { hint: '', description: 'show this list' },
    },
  };
  const noTask = () =>
    tasks.length
      ? `No task selected. Pick one: /gate use ${tasks
          .slice(0, 5)
          .map((t) => t.id)
          .join(' | ')}`
      : 'No contracts found. Create one with /gate init, or write .pi/tasks/<ID>.yaml (see examples/task.yaml).';
  const gateCommand = {
    description:
      'Acceptance — status | use ID | init | check | report | approve | fail | arm | help',
    getArgumentCompletions: buildCompletions(gateSpec),
    handler: async (args, ctx) => {
      await init(ctx);
      const [action = 'status', ...rest] = words(args);
      if (action === 'help') return output(ctx, usageText('gate', gateSpec));
      if (busy && !['status', 'report'].includes(action))
        throw Error('Wait for the current verification to finish');
      if (action === 'templates')
        return output(
          ctx,
          templates.map((t) => `${t.id} · ${t.label} · ${t.description}`).join('\n'),
        );
      if (action === 'create') {
        if (rest.length) throw Error('Use /acceptance create sem argumentos para abrir o diálogo.');
        return output(
          ctx,
          await createAcceptance(ctx, {
            root: rt.root,
            config: rt.config.acceptanceGate,
            selectTask: async (task) => {
              try {
                setTask(pi, task.id);
              } catch {
                ctx.ui.notify(
                  `Task ${task.id} criada. Não foi possível selecionar nesta sessão; use /acceptance use ${task.id}.`,
                  'warning',
                );
              }
              current = task;
              armed = false;
            },
          }),
        );
      }
      if (action === 'init') {
        if (!ctx.isProjectTrusted())
          throw Error(
            'Project trust is required before the gate writes contracts into this repository.',
          );
        const path = await safePath(rt.root, '.pi/tasks/TASK-001.yaml');
        await mkdir(join(rt.root, '.pi', 'tasks'), { recursive: true });
        await writeFile(
          path,
          'task:\n  id: TASK-001\n  title: Verify implementation\n  risk: moderate\n  acceptance:\n    - id: tests\n      type: test\n      command: node --test\n      required: true\n  maxAutoRevisions: 2\n',
          { flag: 'wx' },
        );
        output(ctx, { created: path });
        return;
      }
      if (action === 'use') {
        if (!rest[0])
          throw Error(
            tasks.length
              ? `use needs a TASK-ID. Contracts: ${tasks.map((t) => t.id).join(', ')}`
              : ctx.isProjectTrusted()
                ? 'use needs a TASK-ID, but .pi/tasks/*.yaml is empty here. Create one with /gate init.'
                : 'No contracts visible because this project is not trusted, so .pi/tasks/ is not read. Trust the project, then run /gate init.',
          );
        const t = tasks.find((t) => t.id === rest[0]);
        if (!t)
          throw Error(
            `Unknown task "${rest[0]}". Contracts in .pi/tasks: ${tasks.map((t) => t.id).join(', ') || 'none — run /gate init'}`,
          );
        setTask(pi, t.id);
        current = t;
        return output(ctx, { taskId: t.id });
      }
      if (!current) throw Error(noTask());
      if (action === 'approve' && !rest.join(' ').trim())
        throw Error(
          'approve needs a justification — a human reason is the record, not a checkbox. Example: /gate approve tests cover the fix and diff is scoped to src/auth',
        );
      if (action === 'check') {
        const approvedHash = hash(current);
        if (!(await rt.confirm(ctx, 'Run task checkers?', JSON.stringify(current.acceptance))))
          throw Error('Approval required; use CLI --approve in CI');
        return output(ctx, await check(ctx, true, approvedHash));
      }
      if (action === 'arm') {
        armed = await rt.confirm(ctx, 'Authorize automatic verification?', current.title);
        armedContract = hash(current);
        armedUntil = Date.now() + rt.config.acceptanceGate.approvalTtlSeconds * 1000;
        await rt.emit('gate.verification_authorized', { taskId: current.id, armed });
        return output(ctx, { armed });
      }
      if (action === 'approve') {
        const snap = await snapshot(rt.root, {
          ignorePaths: evidenceIgnore(current, rt.config.acceptanceGate),
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
            expiresAt: new Date(
              Date.now() + rt.config.acceptanceGate.approvalTtlSeconds * 1000,
            ).toISOString(),
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
        const snap = await snapshot(rt.root, {
          ignorePaths: evidenceIgnore(current, rt.config.acceptanceGate),
        });
        const stale =
          s.report &&
          (s.report.snapshot.workingTreeHash !== snap.workingTreeHash ||
            s.report.snapshot.commitHash !== snap.commitHash ||
            s.report.contractHash !== hash(current));
        const receipts = s.report?.receipts ?? [];
        const next = stale
          ? 'Evidence is stale (code, contract or commit changed). Run /gate check.'
          : !receipts.length
            ? 'Nothing verified yet. Run /gate check.'
            : s.status === 'accepted'
              ? 'Accepted for this snapshot.'
              : receipts.some((r) => r.status === 'fail')
                ? 'A checker failed. Fix it, then /gate check.'
                : receipts.some((r) => r.status === 'needs-human' || r.status === 'not-run')
                  ? 'Waiting on human or un-run evidence: /gate approve <justification> or /gate check.'
                  : 'Run /gate report for full receipts.';
        return output(
          ctx,
          [
            `task ${current.id} · ${stale ? 'stale' : (s.status ?? 'draft')} · ${receipts.length} receipt(s)`,
            ...receipts.map(
              (r) =>
                `  ${r.status ?? '?'}  ${r.id ?? r.criterionId ?? '?'}${r.required === false ? ' (optional)' : ''}`,
            ),
            ...(action === 'report'
              ? [
                  `history: ${
                    (await rt.store.rows('tasks').filter((r) => r.entityId === entity(ctx))).length
                  } attempt(s) recorded`,
                  JSON.stringify(s.report ?? null),
                ]
              : []),
            next,
          ].join('\n'),
        );
      }
      throw Error(`Unknown /gate ${action}\n${usageText('gate', gateSpec)}`);
    },
  };
  pi.registerCommand('gate', gateCommand);
  pi.registerCommand('acceptance', {
    ...gateCommand,
    description: 'Acceptance — create | templates | status | use ID | check | help',
  });
}
