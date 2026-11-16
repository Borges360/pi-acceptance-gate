/**
 * The `/gate` panel.
 *
 * One screen that says what the gate is currently doing — which contract, why that
 * contract, which checkers this session can actually run, how many continuations are
 * allowed — and lets every one of those be changed with two keystrokes. Configuration
 * edits remain a visible draft until Ctrl+S validates and persists them; navigation and
 * Escape never write. Explicit session actions keep their own, clearly reported effect.
 *
 * The rows come from `FIELDS`, one exported table (rule B): the panel cannot offer a
 * value the table refuses, because the panel does not have its own copy of the values.
 * That duplication is what shipped `Invalid selected-as` in the economist: the row
 * listed the declared default, the writer rejected it, nothing was saved, and 49 green
 * tests never saw it because the fake repeated the same second list.
 *
 * `pi-tui` and the coding-agent theme helpers are host modules. They are **not**
 * imported here: `index.ts` imports them statically and hands them over through
 * `provideHost()`, because a dynamic `await import('@earendil-works/pi-tui')` from
 * inside an extension is resolved by Node and dies with `ERR_MODULE_NOT_FOUND`. The
 * lazy import below stays only as the fallback for whoever loads `extension.mjs`
 * directly (`pi -e ./extension.mjs`), and it never fails in silence — see `degrade`.
 */
import { merge } from './lib/core.mjs';
import { languageName, translate, translateText } from './lib/i18n.mjs';
import { gateDefaults, validate as validateContract } from './gate.mjs';
import { continuationCap, ARM_SCOPES, ARM_ACTIONS, TTL_CHOICES, CHECKER_COST, byCost } from './select.mjs';

/** Every writable knob of `acceptanceGate`, in panel order. One table, one source. */
export const FIELDS = {
  enabled: {
    label: 'Gate ativo',
    lock: 'enabled',
    values: ['on', 'off'],
    current: (c) => (c.enabled ? 'on' : 'off'),
    patch: (v) => ({ enabled: v === 'on' }),
    note: (v) => (v === 'on' ? 'gate ligado — contratos voltam a ser cobrados' : 'gate desligado nesta sessão e no arquivo'),
    hint: 'on cobra o contrato; off deixa a sessão seguir sem verificação',
  },
  autoSelect: {
    label: 'Auto-seleção do contrato',
    lock: 'autoSelect',
    values: ['on', 'off'],
    current: (c) => (c.autoSelect === false ? 'off' : 'on'),
    patch: (v) => ({ autoSelect: v === 'on' }),
    note: (v) =>
      v === 'on'
        ? 'auto-seleção anunciada: 1 contrato ou aderência clara decide, empate pergunta'
        : 'nada é escolhido sem você decidir — o painel pergunta toda sessão',
    hint: 'on decide quando não há ambiguidade (e diz por quê); off exige escolha explícita',
  },
  autoVerify: {
    label: 'Verificar a cada candidata',
    lock: 'autoVerifyOnCandidate',
    values: ['on', 'off'],
    current: (c) => (c.autoVerifyOnCandidate ? 'on' : 'off'),
    patch: (v) => ({ autoVerifyOnCandidate: v === 'on' }),
    note: (v) => `verificação automática em cada candidata → ${v}`,
    hint: 'só tem efeito com uma autorização `arm` em vigor',
  },
  continuePending: {
    label: 'Continuar por checks pendentes',
    lock: 'continueForPendingChecks',
    values: ['on', 'off'],
    current: (c) => (c.continueForPendingChecks ? 'on' : 'off'),
    patch: (v) => ({ continueForPendingChecks: v === 'on' }),
    note: (v) => `continuação por checks pendentes → ${v}`,
    hint: 'on pede mais uma rodada quando falta evidência obrigatória',
  },
  maxAutoRevisions: {
    label: 'Continuações (pedido)',
    lock: 'maxAutoRevisions',
    values: ['0', '1', '2', '3'],
    current: (c) => String(c.maxAutoRevisions ?? 2),
    patch: (v) => ({ maxAutoRevisions: Number(v) }),
    // The clamp is real (`Math.min(1, …)` in agent_before_settle) and used to be
    // invisible; asking for 3 and getting 1 looked like the setting was ignored.
    note: (v, c = c0()) => {
      const cap = continuationCap(v, c.maxAutoRevisions);
      return `continuações: ${cap.applied}${cap.requested > cap.applied ? ' (teto global 1)' : ` de ${cap.requested} pedido(s)`}`;
    },
    hint: 'o teto efetivo é 1 por rodada do agente — exibido no status, não escondido',
  },
  armScope: {
    label: 'Alcance do arm',
    lock: 'armScope',
    values: ARM_SCOPES,
    current: (c) => (ARM_SCOPES.includes(c.armScope) ? c.armScope : 'ttl'),
    patch: (v) => ({ armScope: v }),
    note: (v) =>
      v === 'once'
        ? 'arm vale só para a próxima verificação (nada persiste)'
        : v === 'always'
          ? 'arm renovado neste projeto enquanto o gate estiver ligado'
          : 'arm vale `Validade do arm` (persiste approvalTtlSeconds)',
    hint: 'autorização para verificar sem perguntar de novo',
  },
  ttl: {
    label: 'Validade do arm',
    lock: 'approvalTtlSeconds',
    values: TTL_CHOICES.map((t) => t.value),
    current: (c) => TTL_CHOICES.find((t) => t.seconds === c.approvalTtlSeconds)?.value ?? '15min',
    patch: (v) => ({ approvalTtlSeconds: TTL_CHOICES.find((t) => t.value === v).seconds }),
    note: (v) => `validade do arm → ${v}`,
    hint: 'só tem efeito com alcance `ttl`',
  },
  scopeSource: {
    label: 'Escopo do gate',
    lock: 'scope',
    values: ['available', 'declared'],
    current: (c) => c.scope?.source ?? 'available',
    patch: (v) => ({ scope: { source: v } }),
    note: (v) =>
      v === 'available'
        ? 'escopo = o que esta sessão consegue executar; o resto aparece out-of-scope'
        : 'escopo = tudo que o contrato declara; capability ausente vira inconclusive',
    hint: 'não muda nenhum veredito com `strict` on: muda o motivo exibido',
  },
  scopeStrict: {
    label: 'Escopo estrito',
    lock: 'scope',
    values: ['on', 'off'],
    current: (c) => (c.scope?.strict === false ? 'off' : 'on'),
    patch: (v) => ({ scope: { strict: v === 'on' } }),
    note: (v) =>
      v === 'on'
        ? 'critério obrigatório fora do escopo ainda bloqueia a aceitação'
        : 'FORA DO ESCOPA RELAXA O VEREDITO: aceitação pode subir sem a evidência — use quando faltar capacidade no ambiente e você aceitar isso',
    hint: 'on mantém o veredito de hoje (só o motivo muda); off tira do conjunto obrigatório',
  },
  allowedExecutables: {
    label: 'Executáveis allowlisted',
    lock: 'allowedExecutables',
    kind: 'list',
    listKey: 'allowedExecutables',
    // A typed `/gate allow exe <name>` may name something the candidate list does not
    // know; the table says what shape is acceptable, so the command path and the panel
    // still share one definition of "a value this field takes".
    accepts: (v) => /^(add|remove):[\w.:@/-]{1,64}$/.test(String(v)),
    candidates: ['mvn', 'gradle', 'dotnet', 'go', 'pytest', 'terraform', 'npm', 'npx', 'node'],
    values: (c) => [
      ...(c.allowedExecutables ?? []).map((x) => `remove:${x}`),
      ...(FIELDS.allowedExecutables.candidates ?? [])
        .filter((x) => !(c.allowedExecutables ?? []).includes(x))
        .map((x) => `add:${x}`),
    ],
    current: (c) => `${(c.allowedExecutables ?? []).length} liberado(s)`,
    patch: (v, c) => {
      const [op, exe] = String(v).split(':');
      const list = c.allowedExecutables ?? [];
      return {
        allowedExecutables: op === 'add' ? [...new Set([...list, exe])] : list.filter((x) => x !== exe),
      };
    },
    note: (v) =>
      String(v).startsWith('add:')
        ? `⚠ widening de segurança: ${v.slice(4)} pode rodar o que o contrato mandar`
        : `${v.slice(7)} voltou a ser recusado antes de executar`,
    hint: 'ampliar exige confirmação explícita e escreve no arquivo do PROJETO',
  },
  allowedHosts: {
    label: 'Hosts allowlisted',
    lock: 'allowedHosts',
    kind: 'list',
    listKey: 'allowedHosts',
    accepts: (v) => /^(add|remove):[\w.:@/-]{1,120}$/.test(String(v)),
    // Candidates are the hosts the *contract* asks for (and the session therefore
    // cannot reach) — never a made-up example, because the panel must not offer a
    // value the table would refuse.
    values: (c, state = {}) => [
      ...(c.allowedHosts ?? []).map((x) => `remove:${x}`),
      ...(state.contractHosts ?? []).filter((h) => !(c.allowedHosts ?? []).includes(h)).map((h) => `add:${h}`),
    ],
    current: (c) => `${(c.allowedHosts ?? []).length} liberado(s)`,
    patch: (v, c) => {
      const [op, host] = String(v).split(':');
      const list = c.allowedHosts ?? [];
      return { allowedHosts: op === 'add' ? [...new Set([...list, host])] : list.filter((x) => x !== host) };
    },
    note: (v) =>
      String(v).startsWith('add:')
        ? `⚠ widening de segurança: a sessão poderá chamar ${v.slice(4)}`
        : `${v.slice(7)} saiu da allowlist`,
    hint: 'checker api_contract só alcança um host desta lista',
  },
};

/** Defaults used by `note` when a caller has no live config at hand. */
export const c0 = () => gateDefaults.acceptanceGate;

/** Value list of a field, always resolved through the table (never a copy of it). */
export function fieldValues(id, conf = c0(), state = {}) {
  const field = FIELDS[id];
  if (!field) throw Error(`campo desconhecido: ${id}`);
  return typeof field.values === 'function' ? field.values(conf ?? c0(), state) : field.values;
}

/**
 * The one writer. Lock, value membership and persistence happen here, so the text
 * command and the panel cannot drift apart — the panel only ever shows what this
 * accepts. Returns `{ patch, note }`; throws with the accepted values listed.
 */
export function applyField(conf, id, value, { locked = {}, state = {} } = {}) {
  const field = FIELDS[id];
  if (!field) throw Error(`campo desconhecido: ${id}`);
  if (Object.hasOwn(locked, field.lock))
    throw Error(`acceptanceGate.${field.lock} está travado por política global.`);
  const allowed = fieldValues(id, conf, state);
  if (!allowed.includes(value) && !(field.accepts?.(value) ?? false))
    throw Error(`Invalid ${id}: ${value}\nUse: ${allowed.join(' | ') || '(nada a oferecer agora)'}`);
  const patch = field.patch(value, conf);
  return { patch, note: field.note(value, conf), id, value };
}

/** Rows of the screen, derived from `FIELDS` — nothing here knows a value by itself. */
function localizedFieldNote(id, conf, value, language) {
  if (language === 'pt-BR') return FIELDS[id].note(value, conf);
  if (id === 'enabled') return translate(language, value === 'on' ? 'gateOnNote' : 'gateOffNote').text;
  if (id === 'autoSelect') return translate(language, value === 'on' ? 'autoSelectOnNote' : 'autoSelectOffNote').text;
  if (id === 'autoVerify') return translate(language, 'autoVerifyNote', { value }).text;
  if (id === 'continuePending') return translate(language, 'continuePendingNote', { value }).text;
  if (id === 'maxAutoRevisions') {
    const cap = continuationCap(value, conf.maxAutoRevisions);
    return cap.requested > cap.applied
      ? translate(language, 'revisionsGlobalNote', { applied: cap.applied }).text
      : translate(language, 'revisionsRequestedNote', { applied: cap.applied, requested: cap.requested }).text;
  }
  if (id === 'armScope')
    return translate(language, value === 'once' ? 'armOnceNote' : value === 'always' ? 'armAlwaysNote' : 'armTtl').text;
  if (id === 'ttl') return translate(language, 'ttlNote', { value }).text;
  if (id === 'scopeSource') return translate(language, value === 'available' ? 'scopeAvailableNote' : 'scopeDeclaredNote').text;
  if (id === 'scopeStrict') return translate(language, value === 'on' ? 'strictOnNote' : 'strictOffNote').text;
  return translateText(language, FIELDS[id].note(value, conf));
}

export function enumItems({ conf, locked = {}, language = 'pt-BR' }) {
  return Object.entries(FIELDS)
    .filter(([id]) => FIELDS[id].kind !== 'list')
    .filter(([id]) => !Object.hasOwn(locked, FIELDS[id].lock))
    .map(([id, field]) => ({
      id,
      label: translateText(language, field.label),
      currentValue: field.current(conf),
      values: fieldValues(id, conf),
      description: `${translateText(language, field.hint)} · ${localizedFieldNote(id, conf, field.current(conf), language)}`,
    }));
}

/** Rows of a list field (`add:`/`remove:` actions, still produced by the table). */
export function listItems(conf, { locked = {}, state = {}, language = 'pt-BR' } = {}) {
  return Object.entries(FIELDS)
    .filter(([, field]) => field.kind === 'list')
    .filter(([id]) => !Object.hasOwn(locked, FIELDS[id].lock))
    .map(([id, field]) => ({
      id,
      label: translateText(language, field.label),
      currentValue: field.current(conf),
      submenu: true,
      description: fieldValues(id, conf, state).length
        ? translateText(language, field.hint)
        : `${translateText(language, field.hint)} · ${translate(language, 'emptyListNote', { kind: id === 'allowedHosts' ? 'host' : 'exe' }).text}`,
    }));
}

/** Submenu rows that are not config fields: the decisions a session actually has. */
export function stateItems(state) {
  return [
    {
      id: 'contract',
      label: 'Contrato desta sessão',
      currentValue: state.contract ? state.contract.id : 'nenhum',
      submenu: true,
      description: state.reason ?? 'nenhuma decisão de contrato tomada',
    },
    {
      id: 'checkers',
      label: 'Checkers do contrato',
      currentValue: `${state.checkers?.length ?? 0} · ${state.outOfScope ?? 0} fora do escopo`,
      submenu: true,
      description: 'custo aproximado de cada um e por que está fora, se estiver',
    },
    {
      id: 'arm',
      label: 'Autorizar verificação',
      currentValue: state.armed ? `armado até ${state.armedUntil}` : 'desarmado',
      submenu: true,
      description: 'só esta verificação · por TTL (persiste) · sempre neste projeto',
    },
    {
      id: 'report',
      label: 'Última verificação',
      currentValue: state.report ? state.report.status : 'nada verificado',
      submenu: true,
      description: 'receipts, motivo do veredito e o que travou',
    },
    {
      id: 'create',
      label: 'Criar contrato',
      currentValue: '—',
      submenu: true,
      description: 'id, título, risco e checkers ordenados por custo → .pi/tasks/<ID>.yaml',
    },
    {
      id: 'help',
      label: 'Modo linha de comando',
      currentValue: '—',
      submenu: true,
      description: 'os comandos diretos continuam válidos e têm autocomplete',
    },
  ];
}

/** The whole screen: state first, then config rows, then the command reference. */
export function panelItems({ conf, locked = {}, state, language = 'pt-BR', languageEnabled = true }) {
  const rows = [
    ...listItems(conf, { locked, state, language }),
    ...stateItems(state),
    ...enumItems({ conf, locked, language }),
  ];
  if (languageEnabled) {
    rows.unshift({
      id: 'uiLanguage',
      label: translateText(language, 'Idioma'),
      currentValue: languageName(language),
      values: ['en', 'pt-BR'],
      description: translateText(language, 'Idioma da interface, salvo somente neste projeto.'),
    });
  }
  return rows.map((item) => {
    const fromFieldTable = Object.hasOwn(FIELDS, item.id);
    const alreadyLocalized = fromFieldTable || item.id === 'uiLanguage';
    return {
      ...item,
      label: alreadyLocalized ? item.label : translateText(language, item.label),
      currentValue: translateText(language, item.currentValue),
      description: alreadyLocalized ? item.description : translateText(language, item.description ?? ''),
    };
  });
}

export function panelTitle(conf, state, language = 'pt-BR') {
  const cap = continuationCap(state.contract?.maxAutoRevisions, conf.maxAutoRevisions);
  return translate(language, 'panelTitle', {
    enabled: conf.enabled ? 'ON' : 'off',
    id: state.contract?.id ?? '—',
    mode: state.mode ?? 'none',
    out: state.outOfScope ?? 0,
    count: cap.applied,
    cap: cap.requested > cap.applied ? (language === 'pt-BR' ? ' (teto global)' : ' (global cap)') : '',
  }).text;
}

/** Human lines for the `checkers` submenu: cost, requirement and the real reason. */
export function checkerLines(contract, report, conf, language = 'pt-BR') {
  const rows = byCost(contract?.acceptance ?? []);
  if (!rows.length) return [translateText(language, 'O contrato não declara checkers — é só uma promessa.')];
  const lines = rows.map((c) => {
    const receipt = report?.receipts?.find((r) => r.criterionId === c.id);
    const blocked = receipt?.outOfScope === true;
    return [
      `${c.id} · ${c.type} · custo ${CHECKER_COST[c.type] ?? 5} · ${c.required === false ? 'opcional' : 'obrigatório'}`,
      `   ${receipt ? `${receipt.status}${blocked ? ' (out-of-scope) ' : ' '} ${receipt.reasonCode ?? receipt.error ?? ''}`.trim() : 'não executado'}`,
      c.command ? `   comando: ${Array.isArray(c.command) ? c.command.join(' ') : c.command}` : '',
      c.url ? `   url: ${c.url}` : '',
      blocked && conf.scope?.strict === false ? '   relaxado: não bloqueia o veredito com strict off' : '',
    ]
      .filter(Boolean)
      .join('\n');
  });
  return [`escopo: ${conf.scope?.source ?? 'available'} · strict ${conf.scope?.strict === false ? 'off' : 'on'}`, ...lines]
    .map((line) => translateText(language, line));
}

/** Human lines for the `report` submenu. */
export function reportLines(report, contract, language = 'pt-BR') {
  if (!report)
    return [
      translateText(language, 'Nenhuma verificação nesta sessão.'),
      translateText(language, 'Veja "Autorizar verificação" para rodar sem perguntar de novo, ou use /gate check.'),
    ];
  const blocked = (report.receipts ?? []).filter((r) => !['pass', 'needs-human'].includes(r.status));
  return [
    `veredito: ${report.status}${report.reason ? ` · ${report.reason}` : ''}`,
    `contrato: ${report.taskId} · ${contract?.id === report.taskId ? 'o mesmo desta sessão' : 'mudou desde então'}`,
    `obrigatórios que não passaram: ${blocked.map((r) => `${r.criterionId} (${r.reasonCode ?? r.status})`).join(', ') || 'nenhum'}`,
    `fora do escopo: ${(report.outOfScope ?? []).map((r) => `${r.criterionId} (${r.reasonCode ?? r.error})`).join(', ') || 'nenhum'}`,
    `snapshot: ${report.snapshot?.commitHash ?? '?'} · worktree ${String(report.snapshot?.workingTreeHash ?? '').slice(0, 12)}`,
  ].map((line) => translateText(language, line));
}

/**
 * The rows the `arm` submenu offers, straight from `ARM_ACTIONS` (rule B): every row
 * says which of the two table fields it writes, and `once` writes none of them.
 */
export function armRows(conf, state, language = 'pt-BR') {
  return ARM_ACTIONS.map((action, i) => ({
    value: action.value,
    label:
      (i === 0 ? '▸ recomendado ' : '') +
      (action.scope === 'once'
        ? 'só esta verificação'
        : action.scope === 'always'
          ? 'sempre neste projeto'
          : `por ${action.value.slice(4)}`),
    description: action.scope === 'once'
      ? 'nada é escrito no arquivo' + (state?.armed ? ' · já está armado' : '')
      : action.scope === 'always'
        ? 'escreve armScope: always e autoVerifyOnCandidate: true'
        : `escreve armScope: ttl + approvalTtlSeconds: ${action.seconds}`,
  })).map((row) => ({
    ...row,
    label: translateText(language, row.label),
    description: translateText(language, row.description),
  }));
}

/** Validate a drafted contract before it is written. */
export function draftValidates(document) {
  validateContract(document);
  return true;
}

/** Test seam: the host modules the entry point imported statically. */
export const host = { tui: undefined, agent: undefined };

/**
 * Wire `index.ts`'s static imports into the seam. Static import at the entry point is
 * the only path that resolves under pi's jiti loader; the lazy import in
 * `runDashboard` is a fallback for direct `extension.mjs` loads only.
 */
export function provideHost(tui, agent) {
  if (tui) host.tui = tui;
  if (agent) host.agent = agent;
  return host;
}

/**
 * Which export the screen needs, and from which package. `Container`/`SettingsList`/
 * `SelectList`/`Text`/`Input` are pi-tui (`pi-tui/dist/index.d.ts:32`);
 * `DynamicBorder`, the list themes and the key helpers are pi-coding-agent
 * (`pi-coding-agent/dist/index.d.ts:36-37`). In the economist `DynamicBorder` was
 * destructured off pi-tui, arrived `undefined`, and `new DynamicBorder(...)` threw
 * inside the `ctx.ui.custom()` factory: no menu for the user, 49 green tests, because
 * the fake repeated the wrong provenance. `scripts/smoke-panel.mjs` checks this table
 * against the installed host.
 */
export const HOST_EXPORTS = {
  '@earendil-works/pi-tui': ['Container', 'SettingsList', 'SelectList', 'Text', 'Input', 'matchesKey'],
  '@earendil-works/pi-coding-agent': [
    'DynamicBorder',
    'getSettingsListTheme',
    'getSelectListTheme',
  ],
};
/** Used when present, literal fallbacks when not (same package as above). */
export const OPTIONAL_EXPORTS = {
  '@earendil-works/pi-tui': ['truncateToWidth'],
  '@earendil-works/pi-coding-agent': ['keyHint', 'keyText'],
};

/** Name the exports the host does not actually provide (a missing module is all of them). */
export function missingHostExports(tuiPkg, agentPkg) {
  const mods = {
    '@earendil-works/pi-tui': tuiPkg,
    '@earendil-works/pi-coding-agent': agentPkg,
  };
  return Object.entries(HOST_EXPORTS).flatMap(([name, exports]) =>
    exports.filter((key) => typeof mods[name]?.[key] !== 'function').map((key) => `${name}.${key}`),
  );
}

function why(error) {
  return String(error?.code ?? error?.message ?? error).split('\n')[0];
}

/** Degradation is allowed; silence is not. Returns false so the caller prints state. */
function degrade(ctx, reason, language = 'en') {
  try {
    ctx?.ui?.notify?.(translateText(language, `Gate sem painel interativo: ${reason}`), 'warning');
  } catch {
    // A broken notify must not replace the reason with a second error.
  }
  return false;
}

/**
 * Show the panel. `deps` = `{ ctx, title, items, onChange, menus }`; `onChange(id,
 * value, update, target)` returns the note (or a promise of it) shown to the user.
 * Returns `false` when the host cannot run a custom screen, so the caller falls back
 * to the text panel — which leads with state, never with a grammar dump.
 */
export async function runDashboard(deps, injection = {}) {
  const { ctx, title, items, onChange, menus } = deps;
  const language = () => deps.getLanguage?.() ?? deps.language ?? 'en';
  const tr = (text) => translateText(language(), text);
  const isDirty = deps.isDirty ?? (() => false);
  const isDraftChange = deps.isDraftChange ?? (() => false);
  if (ctx.mode !== 'tui' || typeof ctx.ui.custom !== 'function') return false;
  let tuiPkg = injection.tuiPkg ?? host.tui,
    agentPkg = injection.agentPkg ?? host.agent;
  if (!tuiPkg) {
    try {
      tuiPkg = await import('@earendil-works/pi-tui');
    } catch (error) {
      return degrade(ctx, `@earendil-works/pi-tui indisponível (${why(error)})`, language());
    }
  }
  if (!agentPkg) {
    try {
      agentPkg = await import('@earendil-works/pi-coding-agent');
    } catch (error) {
      return degrade(ctx, `@earendil-works/pi-coding-agent indisponível (${why(error)})`, language());
    }
  }
  const missing = missingHostExports(tuiPkg, agentPkg);
  if (missing.length)
    return degrade(
      ctx,
      `faltam exports: ${missing.join(', ')} — este pi não expõe a tela customizada esperada`,
      language(),
    );
  const { Container, SettingsList, SelectList, Text, Input, matchesKey } = tuiPkg;
  const { DynamicBorder, getSettingsListTheme, getSelectListTheme, keyHint, keyText } = agentPkg;
  const changed = [];
  let pendingTarget = null;
  let status = '';
  let saving = false;
  let discardPending = false;
  let closed = false;
  await ctx.ui.custom((tuiRef, theme, keybindings, done) => {
    const cancel = (data) => keybindings?.matches?.(data, 'tui.select.cancel') === true;
    const saveKey = (data) => matchesKey(data, 'ctrl+s') === true;
    const statusViews = [];
    let titleView;
    const refresh = () => {
      if (closed) return;
      const label = `${tr(deps.getTitle?.() ?? title)}${isDirty() ? ' *' : ''}`;
      if (titleView) titleView.setText(theme.fg('accent', theme.bold ? theme.bold(label) : label));
      for (const view of statusViews)
        view.setText(theme.fg(status.startsWith('Falha') ? 'error' : 'muted', tr(status || (isDirty() ? 'Rascunho pendente · Ctrl+S salva' : ''))));
      tuiRef.requestRender();
    };
    const statusLine = () => {
      const line = new Text('', 1, 0);
      statusViews.push(line);
      refresh();
      return line;
    };
    const setStatus = (message) => {
      if (closed) return;
      status = String(message ?? '').split('\n')[0];
      refresh();
    };
    const closePanel = (discarded = false) => {
      if (closed) return;
      closed = true;
      done({ changed, discarded });
    };
    const cancelRoot = () => {
      if (saving) {
        setStatus('Salvando configuração; aguarde a gravação terminar.');
        return;
      }
      if (isDirty()) {
        if (!discardPending) {
          discardPending = true;
          setStatus('Alterações não salvas. Ctrl+S salva; Esc novamente descarta.');
          return;
        }
        deps.onDiscard?.((target, replacement) => list.updateValue(target, replacement));
        closePanel(true);
        return;
      }
      closePanel(false);
    };
    const saveDraft = async () => {
      if (closed) return;
      if (saving) return;
      if (!isDirty()) {
        discardPending = false;
        setStatus('Nenhuma alteração pendente para salvar.');
        return;
      }
      if (typeof deps.onSave !== 'function') {
        setStatus('Falha ao salvar: o painel não recebeu um gravador.');
        return;
      }
      discardPending = false;
      saving = true;
      setStatus('Validando e salvando rascunho…');
      try {
        const note = await deps.onSave();
        if (note) changed.push(note);
        setStatus(note || 'Alterações salvas.');
      } catch (error) {
        const message = String(error?.message ?? error).split('\n')[0];
        setStatus(`Falha ao salvar: ${message}`);
      } finally {
        saving = false;
        refresh();
      }
    };
    const navHint =
      typeof keyText === 'function'
        ? `  ${keyText('tui.select.up')}/${keyText('tui.select.down')} navegar · ${keyText('tui.select.confirm')} escolher · ${keyText('tui.select.cancel')} voltar`
        : '  ↑↓ navegar · enter escolher · esc voltar';
    const backHint =
      typeof keyHint === 'function' ? `  ${keyHint('tui.select.cancel', 'voltar')}` : '  esc voltar';
    const box = new Container();
    box.addChild(new DynamicBorder((str) => theme.fg('accent', str)));
    const initialTitle = tr(deps.getTitle?.() ?? title);
    titleView = new Text(theme.fg('accent', theme.bold ? theme.bold(initialTitle) : initialTitle), 1, 0);
    box.addChild(titleView);
    const list = new SettingsList(
      items,
      Math.min(items.length, 12),
      getSettingsListTheme(),
      (id, value) => {
        const note = onChange(id, value, (target, replacement) =>
          list.updateValue(target, tr(replacement)),
          pendingTarget,
        );
        return Promise.resolve(note).then((text) => {
          if (closed) return text;
          if (id === 'uiLanguage') deps.onLanguageChange?.(value);
          if (isDraftChange(id)) setStatus(`Rascunho: ${text ?? `${id} → ${value}`}`);
          else {
            if (text) changed.push(text);
            ctx.ui.notify(tr(text ?? `${id} → ${value}`), 'info');
          }
          refresh();
          return text;
        }).catch((error) => {
          if (closed) return undefined;
          const message = String(error?.message ?? error).split('\n')[0];
          setStatus(`Falha ao aplicar ${id}: ${message}`);
          return `Falha ao aplicar ${id}: ${message}`;
        });
      },
      cancelRoot,
    );
    const frame = (heading) => {
      const inner = new Container();
      inner.addChild(new Text(theme.fg('accent', tr(heading)), 1, 0));
      inner.addChild(statusLine());
      return inner;
    };
    /** A searchable list inside a submenu; esc returns to the main screen. */
    const screen = (heading, rows, onPick, onClose) => {
      const inner = frame(heading);
      const localizedRows = (rows || []).map((row) => typeof row === 'string'
        ? { value: row, label: tr(row) }
        : { ...row, label: tr(row.label ?? row.value), description: tr(row.description ?? '') });
      const select = new SelectList(localizedRows, Math.min(localizedRows.length || 1, 8), getSelectListTheme());
      select.onSelect = (item) => onPick(item.value);
      select.onCancel = () => onClose();
      inner.addChild(select);
      inner.addChild(new Text(theme.fg('dim', navHint.trim()), 1, 0));
      return {
        render: (width) => inner.render(width),
        invalidate: () => inner.invalidate(),
        handleInput: (data) => {
          if (saveKey(data)) return saveDraft();
          discardPending = false;
          select.handleInput(data);
          tuiRef.requestRender();
        },
      };
    };
    const textScreen = (heading, lines, onClose) => {
      const inner = frame(heading);
      for (const line of (lines ?? ['(vazio)']).flatMap((l) => String(l).split('\n')))
        inner.addChild(new Text(theme.fg('muted', `  ${tr(line)}`), 0, 0));
      inner.addChild(new Text(theme.fg('dim', backHint.trim()), 1, 0));
      return {
        render: (width) => inner.render(width),
        invalidate: () => inner.invalidate(),
        handleInput: (data) => {
          if (saveKey(data)) return saveDraft();
          discardPending = false;
          if (cancel(data)) onClose();
        },
      };
    };
    const panels = {
      contract: (_current, close) =>
        screen(
          'Contrato · escolha em que esta sessão trabalha (abre os checkers dele em seguida)',
          menus.contracts(),
          (value) =>
            // Both halves are honoured by the host component: the value writes the row
            // (`onChange`) and `navigateTo` re-selects **and activates** the target
            // (`settings-list.js:222-233`), so the second level opens by itself — do not
            // press enter again, or the user just picks a row of the submenu.
            close(value, { navigateTo: 'checkers' }),
          () => close(),
        ),
      checkers: (_current, close) =>
        textScreen('Checkers do contrato', menus.checkers(), () => close()),
      report: (_current, close) => textScreen('Última verificação', menus.report(), () => close()),
      help: (_current, close) => textScreen('Linha de comando', menus.help(), () => close()),
      arm: (_current, close) =>
        screen(
          'Autorizar verificação automática · o que escreve está em cada linha',
          menus.arm(),
          (value) => close(value),
          () => close(),
        ),
      allowedExecutables: (_current, close) =>
        screen(
          'Executáveis · add é widening de segurança e pede confirmação',
          menus.executables(),
          (value) => close(value),
          () => close(),
        ),
      allowedHosts: (_current, close) =>
        screen(
          'Hosts da allowlist · add é widening de segurança e pede confirmação',
          menus.hosts(),
          (value) => close(value),
          () => close(),
        ),
      create: (_current, close) => {
        const inner = frame('Criar contrato · digite o ID e enviar escreve .pi/tasks/<ID>.yaml');
        const input = new Input({ placeholder: tr('ex.: TASK-002') });
        inner.addChild(input);
        const result = new Text(
          theme.fg('dim', `  ${tr('checkers sugeridos por custo · esc volta ao painel')}`),
          0,
          0,
        );
        inner.addChild(result);
        let pending = null;
        let controller = null;
        let busy = false;
        let closeRequested = false;
        const run = (text) => {
          if (!text || busy) return pending;
          busy = true;
          controller = new AbortController();
          result.setText(theme.fg('dim', `  ${tr('criando…')}`));
          pending = Promise.resolve()
            .then(() => menus.create(text, { signal: controller.signal }))
            .then((lines) => result.setText([lines].flat().map((l) => `  ${tr(l)}`).join('\n')))
            .catch((error) => result.setText(theme.fg(error?.name === 'AbortError' ? 'dim' : 'error', `  ${tr(error?.name === 'AbortError' ? 'operação cancelada' : error.message)}`)))
            .finally(() => {
              busy = false;
              controller = null;
              if (closeRequested) close();
              else tuiRef.requestRender();
            });
          return pending;
        };
        // The host's Input owns what "submit" means (`tui.input.submit`); the screen
        // never compares raw bytes (pi-tui/dist/components/input.d.ts:14).
        input.onSubmit = run;
        return {
          render: (width) => inner.render(width),
          invalidate: () => inner.invalidate(),
          handleInput: (data) => {
          if (saveKey(data)) return saveDraft();
            if (cancel(data)) {
              if (busy) {
              controller?.abort();
                closeRequested = true;
                return pending;
              }
              close();
              return;
            }
            discardPending = false;
            if (busy) return;
            return input.handleInput(data);
          },
        };
      },
    };
    for (const item of items) {
      if (item.submenu !== true) continue;
      const panel = panels[item.id];
      if (!panel) continue;
      item.submenu = (currentValue, close) => {
        // A submenu that is a plain action list (`arm`, `contract`, the two allowlists)
        // does not need the row's own value; the contract editor does.
        pendingTarget = currentValue === '—' ? undefined : currentValue;
        return panel(currentValue === '—' ? undefined : currentValue, close);
      };
    }
    box.addChild(list);
    box.addChild(statusLine());
    box.addChild(new Text(theme.fg('dim', tr('↑↓ navegar · Enter editar/abrir · Ctrl+S salvar · Esc voltar/descartar')), 1, 0));
    box.addChild(new DynamicBorder((str) => theme.fg('accent', str)));
    return {
      render: (width) => {
        if (width >= 56) return box.render(width);

        // pi-tui's SettingsList sizes its value column from the longest label. At a
        // 40-column terminal that can leave only a few cells for values such as
        // "English" or "10 allowed". Compact labels for this render only; their full
        // descriptions remain available when selected and the source rows are restored
        // before returning so language changes and edits keep their canonical labels.
        const compactWidth = Math.max(8, Math.min(16, Math.floor(width) - 24));
        const originalLabels = items.map((item) => item.label);
        const truncate = tuiPkg.truncateToWidth;
        try {
          items.forEach((item, index) => {
            const label = String(originalLabels[index] ?? '');
            if (typeof truncate === 'function') {
              item.label = truncate(label, compactWidth, '…');
              return;
            }
            const characters = Array.from(label);
            item.label = characters.length > compactWidth
              ? `${characters.slice(0, compactWidth - 1).join('')}…`
              : label;
          });
          return box.render(width);
        } finally {
          items.forEach((item, index) => { item.label = originalLabels[index]; });
        }
      },
      invalidate: () => box.invalidate(),
      handleInput: (data) => {
        if (saveKey(data)) return saveDraft();
        if (cancel(data)) {
          cancelRoot();
          return;
        }
        if (saving) return;
        if (discardPending) {
          discardPending = false;
          if (status.startsWith('Alterações não salvas.')) setStatus('');
        }
        list.handleInput(data);
        tuiRef.requestRender();
      },
    };
  });
  return { changed };
}

/** Deep-merge a patch over the live section, the same way `rt.save` does. */
export const mergePatch = (conf, patch) => merge(conf, patch);
