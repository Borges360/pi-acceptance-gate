import { readFile } from 'node:fs/promises';
import { atomicJson, safePath } from './core.mjs';

const entries = [
  ['appName', 'Gate', 'Gate'],
  ['languageLabel', 'Idioma', 'Language'],
  ['languageDescription', 'Idioma da interface, salvo somente neste projeto.', 'Interface language, saved only for this project.'],
  ['languageTitle', 'Idioma / escolha a interface', 'Language / choose the interface'],
  ['languageCurrent', 'atual: {language}', 'current: {language}'],
  ['languageDraft', 'Rascunho do idioma: {language}. Ctrl+S salva a alteração.', 'Language draft: {language}. Ctrl+S saves the change.'],
  ['languageSaved', 'Idioma salvo para este projeto: {language}.', 'Language saved for this project: {language}.'],
  ['languageEnglish', 'English', 'English'],
  ['languagePortuguese', 'Português (Brasil)', 'Português (Brasil)'],
  ['languageUnavailable', 'Falta uma tradução; o texto em inglês será mostrado neste item.', 'A translation is missing; English text is shown for this item.'],
  ['languageInvalid', 'Idioma do projeto inválido; usando inglês.', 'Invalid project language; using English.'],
  ['languageTrusted', 'Idioma só pode ser salvo em um projeto confiável.', 'Language can only be saved in a trusted project.'],
  ['languageSaveFailed', 'Falha ao salvar o idioma. O rascunho continua disponível.', 'Could not save the language. The draft is still available.'],
  ['languageFileInvalid', 'Arquivo de idioma do projeto inválido; nada foi sobrescrito.', 'Project language file is invalid; nothing was overwritten.'],
  ['languageProjectOnly', 'Esta preferência vale somente para o projeto atual.', 'This preference applies only to the current project.'],
  ['languageNoUnsaved', 'Não há configurações pendentes.', 'No unsaved settings.'],
  ['panelTitle', 'Gate · {enabled} · contrato {id} ({mode}) · {out} fora do escopo · continuações {count}{cap}', 'Gate · {enabled} · contract {id} ({mode}) · {out} out of scope · continuations {count}{cap}'],
  ['allowedCount', '{count} liberado(s)', '{count} allowed'],
  ['gateOnNote', 'gate ligado — contratos voltam a ser cobrados', 'Gate enabled — contracts are enforced again'],
  ['gateOffNote', 'gate desligado nesta sessão e no arquivo', 'Gate disabled for this session and in the project file'],
  ['autoSelectOnNote', 'auto-seleção anunciada: 1 contrato ou aderência clara decide, empate pergunta', 'Automatic selection announced: one contract or a clear match is chosen; ties prompt you'],
  ['autoSelectOffNote', 'nada é escolhido sem você decidir — o painel pergunta toda sessão', 'Nothing is chosen without your decision — the panel asks every session'],
  ['autoVerifyNote', 'verificação automática em cada candidata → {value}', 'Automatic verification for each candidate → {value}'],
  ['continuePendingNote', 'continuação por checks pendentes → {value}', 'Continue for pending checks → {value}'],
  ['revisionsGlobalNote', 'continuações: {applied} (teto global 1)', 'Continuations: {applied} (global cap 1)'],
  ['revisionsRequestedNote', 'continuações: {applied} de {requested} pedido(s)', 'Continuations: {applied} of {requested} requested'],
  ['scopeAvailableNote', 'escopo = o que esta sessão consegue executar; o resto aparece out-of-scope', 'Scope = what this session can run; the rest appears out of scope'],
  ['scopeDeclaredNote', 'escopo = tudo que o contrato declara; capability ausente vira inconclusive', 'Scope = everything declared by the contract; a missing capability is inconclusive'],
  ['strictOnNote', 'critério obrigatório fora do escopo ainda bloqueia a aceitação', 'A required out-of-scope check still blocks acceptance'],
  ['strictOffNote', 'FORA DO ESCOPA RELAXA O VEREDITO: aceitação pode subir sem a evidência — use quando faltar capacidade no ambiente e você aceitar isso', 'OUT OF SCOPE RELAXES THE VERDICT: acceptance may pass without this evidence — use only when the environment lacks a capability and you accept that'],
  ['armOnceNote', 'arm vale só para a próxima verificação (nada persiste)', 'Arm applies only to the next verification (nothing persists)'],
  ['armAlwaysNote', 'arm renovado neste projeto enquanto o gate estiver ligado', 'Arm renews for this project while the gate is enabled'],
  ['ttlNote', 'validade do arm → {value}', 'Arm duration → {value}'],
  ['emptyListNote', 'nada pendente: use /gate allow {kind} <valor>', 'Nothing pending: use /gate allow {kind} <value>'],
  ['armDurationLabel', 'por {value}', 'for {value}'],
  ['selectionNoContract', 'nenhum contrato em .pi/tasks/ — pergunte e ajude a criar um', 'No contract exists in .pi/tasks/ — ask the user and help create one'],
  ['selectionExplicit', 'escolha explícita: /gate use {id}', 'Explicit choice: /gate use {id}'],
  ['selectionAutoOff', 'autoSelect está off e há {count} contratos — nada é verificado sem você escolher', 'Automatic selection is off and {count} contracts exist — nothing is checked until you choose'],
  ['selectionSingle', 'único contrato do projeto, selecionado automaticamente ({id})', 'Only project contract, selected automatically ({id})'],
  ['selectionTie', 'empate entre {count} contratos — recomendado {id} ({reason})', 'Tie between {count} contracts — recommended {id} ({reason})'],
  ['selectionAdherence', 'aderência aos {count} arquivo(s) alterados: {reason}', 'Match against {count} changed file(s): {reason}'],
  ['scopeHelp', 'available = só o que a sessão executa · declared = tudo do contrato', 'available = only what the session can run · declared = the full contract scope'],
  ['allowHelp', 'widening de segurança, com confirmação, no arquivo do projeto', 'Security widening, confirmed and saved to the project file'],
  ['denyHelp', 'tirar da allowlist', 'Remove an entry from the allowlist'],
  ['enableHelp', 'ligar o gate (acceptanceGate.enabled: true)', 'Enable the gate (acceptanceGate.enabled: true)'],
  ['disableHelp', 'desligar o gate nesta sessão e no arquivo', 'Disable the gate for this session and in the project file'],
  ['armedOnceNotice', 'armado só para esta verificação · nada foi escrito', 'Armed for this verification only · nothing was written'],
  ['armedAlwaysNotice', 'armado sempre neste projeto · armScope: always + autoVerifyOnCandidate: true', 'Always armed for this project · armScope: always + autoVerifyOnCandidate: true'],
  ['armedTtlNotice', 'armado por {value} · approvalTtlSeconds: {seconds}', 'Armed for {value} · approvalTtlSeconds: {seconds}'],
  ['argScope', 'alcance', 'scope'],
  ['argValue', 'valor', 'value'],
  ['removeItemLabel', 'remover {id}', 'Remove {id}'],
  ['recommendedAllow', '▸ recomendado liberar {value}', '▸ recommended allow {value}'],
  ['allowItemLabel', 'liberar {value}', 'Allow {value}'],
  ['checkerNeedsExecutable', 'o checker {id} pede (custo {cost}) · escreve no arquivo do projeto', 'Checker {id} requires this (cost {cost}) · saved to the project file'],
  ['noContractNeedsExecutable', 'nada do contrato pede este binário agora', 'No contract currently requires this executable'],
  ['hostNotAllowlisted', 'o contrato chama este host e ele não está na allowlist', 'The contract calls this host and it is not on the allowlist'],
  ['nothingToOffer', 'nada a oferecer', 'Nothing to offer'],
  ['noHostTasks', 'nenhum host em .pi/tasks/ — use /gate allow host <host>', 'No host in .pi/tasks/ — use /gate allow host <host>'],
  ['wideningConfirmed', '⚠ {target} NADA foi escrito — isto libera {kind} para contratos deste projeto; escolha a mesma linha de novo para confirmar', '⚠ {target} NOTHING was written — this allows {kind} for this project’s contracts; choose the same row again to confirm'],
  ['fieldEnabled', 'Gate ativo', 'Gate enabled'],
  ['fieldAutoSelect', 'Auto-seleção do contrato', 'Automatic contract selection'],
  ['fieldAutoVerify', 'Verificar a cada candidata', 'Verify each candidate'],
  ['fieldContinue', 'Continuar por checks pendentes', 'Continue for pending checks'],
  ['fieldRevisions', 'Continuações (pedido)', 'Continuations (requested)'],
  ['fieldArmScope', 'Alcance do arm', 'Arm scope'],
  ['fieldTtl', 'Validade do arm', 'Arm duration'],
  ['fieldScope', 'Escopo do gate', 'Gate scope'],
  ['fieldStrict', 'Escopo estrito', 'Strict scope'],
  ['fieldExecutables', 'Executáveis allowlisted', 'Allowed executables'],
  ['fieldHosts', 'Hosts allowlisted', 'Allowed hosts'],
  ['hintEnabled', 'on cobra o contrato; off deixa a sessão seguir sem verificação', 'On requires the contract; Off lets the session continue without verification'],
  ['hintAutoSelect', 'on decide quando não há ambiguidade (e diz por quê); off exige escolha explícita', 'On decides when there is no ambiguity (and explains why); Off requires an explicit choice'],
  ['hintAutoVerify', 'só tem efeito com uma autorização `arm` em vigor', 'Only takes effect while an `arm` authorization is active'],
  ['hintContinue', 'on pede mais uma rodada quando falta evidência obrigatória', 'On requests another turn when required evidence is missing'],
  ['hintRevisions', 'o teto efetivo é 1 por rodada do agente — exibido no status, não escondido', 'The effective cap is 1 per agent turn — shown in status, not hidden'],
  ['hintArmScope', 'autorização para verificar sem perguntar de novo', 'Authorization to verify without asking again'],
  ['hintTtl', 'só tem efeito com alcance `ttl`', 'Only takes effect with `ttl` scope'],
  ['hintScope', 'não muda nenhum veredito com `strict` on: muda o motivo exibido', 'Does not change a verdict with `strict` on; it changes the displayed reason'],
  ['hintStrict', 'on mantém o veredito de hoje (só o motivo muda); off tira do conjunto obrigatório', 'On keeps today’s verdict (only the reason changes); Off removes it from required checks'],
  ['hintExecutables', 'ampliar exige confirmação explícita e escreve no arquivo do PROJETO', 'Widening requires explicit confirmation and writes to the PROJECT file'],
  ['hintHosts', 'checker api_contract só alcança um host desta lista', 'The api_contract checker can reach only a host on this list'],
  ['stateContract', 'Contrato desta sessão', 'Session contract'],
  ['stateCheckers', 'Checkers do contrato', 'Contract checkers'],
  ['stateArm', 'Autorizar verificação', 'Authorize verification'],
  ['stateReport', 'Última verificação', 'Latest verification'],
  ['stateCreate', 'Criar contrato', 'Create contract'],
  ['stateHelp', 'Modo linha de comando', 'Command-line mode'],
  ['descCheckers', 'custo aproximado de cada um e por que está fora, se estiver', 'Approximate cost of each checker and why it is out of scope, if applicable'],
  ['descArm', 'só esta verificação · por TTL (persiste) · sempre neste projeto', 'This verification only · for a TTL (persists) · always in this project'],
  ['descReport', 'receipts, motivo do veredito e o que travou', 'Receipts, verdict reason, and what blocked it'],
  ['descCreate', 'id, título, risco e checkers ordenados por custo → .pi/tasks/<ID>.yaml', 'ID, title, risk, and checkers sorted by cost → .pi/tasks/<ID>.yaml'],
  ['descHelp', 'os comandos diretos continuam válidos e têm autocomplete', 'Direct commands remain available and have autocomplete'],
  ['empty', 'nenhum', 'none'],
  ['disarmed', 'desarmado', 'unarmed'],
  ['notVerified', 'nada verificado', 'not verified'],
  ['outOfScope', 'fora do escopo', 'out of scope'],
  ['statusOn', 'ligado', 'on'],
  ['statusOff', 'desligado', 'off'],
  ['contractReasonNone', 'nenhuma decisão de contrato tomada', 'No contract decision has been made'],
  ['panelFooter', '↑↓ navegar · Enter editar/abrir · Ctrl+S salvar · Esc voltar/descartar', '↑↓ navigate · Enter edit/open · Ctrl+S save · Esc back/discard'],
  ['panelFooterShort', '↑↓ navegar · Enter editar/abrir · Ctrl+S salvar · Esc fechar', '↑↓ navigate · Enter edit/open · Ctrl+S save · Esc close'],
  ['navigateHint', '↑↓ navegar · Enter escolher · Esc voltar', '↑↓ navigate · Enter select · Esc back'],
  ['backHint', 'voltar', 'back'],
  ['dirtyNotice', 'Rascunho pendente · Ctrl+S salva', 'Draft pending · Ctrl+S saves'],
  ['dirtyWarning', 'Alterações não salvas. Ctrl+S salva; Esc novamente descarta.', 'Unsaved changes. Ctrl+S saves; press Esc again to discard.'],
  ['savingWait', 'Salvando configuração; aguarde a gravação terminar.', 'Saving settings; wait for the write to finish.'],
  ['noPending', 'Nenhuma alteração pendente para salvar.', 'No pending changes to save.'],
  ['noWriter', 'Falha ao salvar: o painel não recebeu um gravador.', 'Save failed: the panel did not receive a writer.'],
  ['savingDraft', 'Validando e salvando rascunho…', 'Validating and saving draft…'],
  ['saved', 'Alterações salvas.', 'Changes saved.'],
  ['saveFailed', 'Falha ao salvar:', 'Save failed:'],
  ['applyFailed', 'Falha ao aplicar', 'Could not apply'],
  ['draftPrefix', 'Rascunho:', 'Draft:'],
  ['operationCanceled', 'operação cancelada', 'operation canceled'],
  ['creating', 'criando…', 'creating…'],
  ['createContractTitle', 'Criar contrato · digite o ID e enviar escreve .pi/tasks/<ID>.yaml', 'Create contract · type an ID and submit to write .pi/tasks/<ID>.yaml'],
  ['createContractPlaceholder', 'ex.: TASK-002', 'e.g. TASK-002'],
  ['createContractHint', 'checkers sugeridos por custo · esc volta ao painel', 'Checkers suggested by cost · Esc returns to the dashboard'],
  ['contractTitle', 'Contrato · escolha em que esta sessão trabalha (abre os checkers dele em seguida)', 'Contract · choose what this session works on (its checkers open next)'],
  ['checkersTitle', 'Checkers do contrato', 'Contract checkers'],
  ['reportTitle', 'Última verificação', 'Latest verification'],
  ['helpTitle', 'Linha de comando', 'Command line'],
  ['armTitle', 'Autorizar verificação automática · o que escreve está em cada linha', 'Authorize automatic verification · each row explains what it writes'],
  ['executablesTitle', 'Executáveis · add é widening de segurança e pede confirmação', 'Executables · add widens security access and requires confirmation'],
  ['hostsTitle', 'Hosts da allowlist · add é widening de segurança e pede confirmação', 'Allowlisted hosts · add widens security access and requires confirmation'],
  ['noPanel', 'Gate sem painel interativo:', 'Gate without interactive panel:'],
  ['missingExports', 'faltam exports:', 'Missing exports:'],
  ['missingInteractivePanel', 'este pi não expõe a tela customizada esperada', 'this Pi host does not expose the expected custom screen'],
  ['wideningWarning', 'NADA foi escrito — isto libera', 'NOTHING was written — this allows'],
  ['chooseAgain', 'para contratos deste projeto; escolha a mesma linha de novo para confirmar', 'for this project’s contracts; choose the same row again to confirm'],
  ['noAction', 'nada a fazer aqui', 'nothing to do here'],
  ['contractSession', 'contrato desta sessão', 'session contract'],
  ['explicitChoice', 'escolha explícita (só esta sessão)', 'explicit choice (this session only)'],
  ['contractMissing', 'não existe mais', 'no longer exists'],
  ['contractCreated', 'criado', 'created'],
  ['savedAt', 'salvo em', 'saved to'],
  ['savedAndActive', 'já em efeito', 'now in effect'],
  ['dashboardNoChange', 'Gate · nada foi alterado no painel.', 'Gate · no dashboard settings were changed.'],
  ['dashboardDiscarded', 'Gate · rascunho descartado; nenhuma configuração pendente foi salva.', 'Gate · draft discarded; no pending settings were saved.'],
  ['dashboardChanges', 'Gate · {count} mudança(s)', 'Gate · {count} change(s)'],
  ['fallbackTitle', 'Gate', 'Gate'],
  ['fallbackContract', 'contrato:', 'contract:'],
  ['fallbackScope', 'escopo', 'scope'],
  ['lastCheck', 'última verificação:', 'latest verification:'],
  ['noCheck', 'nenhuma', 'none'],
  ['helpDirect', 'Este cliente não tem tela customizada; os comandos diretos funcionam:', 'This client has no custom screen; direct commands are available:'],
  ['checkerScope', 'escopo:', 'scope:'],
  ['strict', 'strict', 'strict'],
  ['required', 'obrigatório', 'required'],
  ['optional', 'opcional', 'optional'],
  ['notRun', 'não executado', 'not run'],
  ['outOfScopeValue', 'fora do escopo', 'out of scope'],
  ['relaxed', 'relaxado:', 'relaxed:'],
  ['relaxedNotice', 'não bloqueia o veredito com strict off', 'does not block the verdict with strict off'],
  ['noCheckersPromise', 'O contrato não declara checkers — é só uma promessa.', 'The contract declares no checkers — it is only a promise.'],
  ['noCheckSession', 'Nenhuma verificação nesta sessão.', 'No verification in this session.'],
  ['verifyHint', 'Veja "Autorizar verificação" para rodar sem perguntar de novo, ou use /gate check.', 'See "Authorize verification" to run without asking again, or use /gate check.'],
  ['verdict', 'veredito:', 'verdict:'],
  ['contractLabel', 'contrato:', 'contract:'],
  ['sameSessionContract', 'o mesmo desta sessão', 'same as this session'],
  ['changedSince', 'mudou desde então', 'changed since then'],
  ['requiredNotPassed', 'obrigatórios que não passaram:', 'required checks that did not pass:'],
  ['none', 'nenhum', 'none'],
  ['snapshot', 'snapshot:', 'snapshot:'],
  ['worktree', 'worktree', 'worktree'],
  ['scopeAvailable', 'available', 'available'],
  ['scopeDeclared', 'declared', 'declared'],
  ['noPendingChanges', 'Nenhuma alteração de configuração pendente.', 'No pending configuration changes.'],
  ['configSaved', 'Configuração validada e salva em', 'Settings validated and saved to'],
  ['recommended', '▸ recomendado', '▸ recommended'],
  ['onlyThisCheck', 'só esta verificação', 'this verification only'],
  ['alwaysProject', 'sempre neste projeto', 'always in this project'],
  ['noFileWrite', 'nada é escrito no arquivo', 'nothing is written to the file'],
  ['alreadyArmed', 'já está armado', 'already armed'],
  ['oneShotNoPersist', 'arm vale só para a próxima verificação (nada persiste)', 'Arm applies only to the next verification (nothing persists)'],
  ['alwaysArmed', 'arm renovado neste projeto enquanto o gate estiver ligado', 'Arm is renewed in this project while the gate is enabled'],
  ['armTtl', 'arm vale `Validade do arm` (persiste approvalTtlSeconds)', 'Arm lasts for `Arm duration` (persists approvalTtlSeconds)'],
  ['armTtlEffect', 'validade do arm → {value}', 'Arm duration → {value}'],
  ['armWritesTtl', 'escreve armScope: ttl + approvalTtlSeconds: {seconds}', 'Writes armScope: ttl + approvalTtlSeconds: {seconds}'],
  ['armWritesAlways', 'escreve armScope: always e autoVerifyOnCandidate: true', 'Writes armScope: always and autoVerifyOnCandidate: true'],
  ['safeWiden', '⚠ widening de segurança:', '⚠ security widening:'],
  ['allowedToday', 'liberado hoje', 'allowed today'],
  ['removeFromAllowlist', 'saiu da allowlist', 'was removed from the allowlist'],
  ['noCandidate', 'nada a oferecer', 'nothing to offer'],
  ['hostContract', 'o contrato chama este host e ele não está na allowlist', 'The contract calls this host and it is not allowlisted'],
  ['noHostTasks', 'nenhum host em .pi/tasks/ — use /gate allow host <host>', 'No host in .pi/tasks/ — use /gate allow host <host>'],
  ['taskId', '{id}', '{id}'],
  ['recommendedCandidate', '▸ recomendado {id}', '▸ recommended {id}'],
  ['candidateFit', 'aderência {score} · {checkers} checker(s) · risco {risk}', 'fit {score} · {checkers} checker(s) · risk {risk}'],
  ['recommendedByCost', 'checkers sugeridos por custo', 'Checkers suggested by cost'],
  ['contractCreatedNotice', 'contrato {id} criado · salvo em {path}', 'Contract {id} created · saved to {path}'],
  ['contractCreatedResult', 'criado {id} · {count} checker(s) · salvo em {path}', 'Created {id} · {count} checker(s) · saved to {path}'],
  ['contractChanged', 'contrato → {id}', 'Contract → {id}'],
  ['selectedBy', ' · {reason}', ' · {reason}'],
  ['continueCount', 'continuações {count}', 'continuations {count}'],
  ['outScopeCount', '{count} fora do escopo', '{count} out of scope'],
  ['checkerCost', 'custo {cost}', 'cost {cost}'],
  ['checkerCommand', 'comando:', 'command:'],
  ['checkerUrl', 'url:', 'url:'],
  ['checkerScopeStatus', 'escopo: {scope} · strict {strict}', 'scope: {scope} · strict {strict}'],
  ['armUntil', 'armado até {time}', 'armed until {time}'],
  ['armedValue', 'armado · {value}', 'armed · {value}'],
  ['disarmedValue', 'desarmado', 'unarmed'],
  ['rowCount', '{count} · {out} fora do escopo', '{count} · {out} out of scope'],
  ['checkRun', 'verificação', 'verification'],
  ['checkerCount', 'checker(s)', 'checker(s)'],
  ['nothingWritten', '⚠ {target} NADA foi escrito', '⚠ {target} NOTHING was written'],
  ['nothingWidening', 'isto libera {kind} para contratos deste projeto', 'this allows {kind} for this project’s contracts'],
  ['localSelectedContract', 'contrato → {id} · escolha explícita (só esta sessão)', 'Contract → {id} · explicit choice (this session only)'],
  ['contractNoLongerExists', 'contrato {id} não existe mais', 'Contract {id} no longer exists'],
  ['noActionPending', 'nada foi escrito; o gate fica quieto até existir um contrato.', 'nothing was written; the gate stays quiet until a contract exists.'],
  ['noContractVerification', 'sem contrato o gate não verifica nada nesta sessão.', 'without a contract, the gate does not verify anything in this session.'],
];

const english = Object.fromEntries(entries.map(([key, , en]) => [key, en]));
const portuguese = Object.fromEntries(entries.map(([key, pt]) => [key, pt]));
const sourceKeys = new Map(entries.map(([key, pt]) => [pt, key]));
const replacements = entries
  .filter(([, pt, en]) => pt !== en && !pt.includes('{'))
  .map(([key, pt, en]) => ({ key, pt, en }))
  .sort((a, b) => b.pt.length - a.pt.length);

export const UI_LANGUAGES = ['en', 'pt-BR'];
export const LANGUAGE_FILE = '.pi/pi-acceptance-gate.locale.json';
export const MESSAGE_KEYS = Object.freeze(Object.keys(english));

const placeholders = (value) => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((m) => m[1]).sort();
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const capturePattern = (name) => {
  if (['count', 'out', 'applied', 'requested', 'cost', 'seconds', 'checkers'].includes(name)) return '(\\d+)';
  if (name === 'score') return '(\\d+(?:\\.\\d+)?)';
  if (['value', 'time', 'id', 'risk', 'kind'].includes(name)) return '([\\p{L}\\p{N}_.:/@-]+)';
  if (name === 'target' || name === 'path' || name === 'reason') return '([^·\\n]+?)';
  return '([^·\\n]+?)';
};

function translateTemplateLine(language, line) {
  for (const [, pt, en] of entries) {
    if (!pt.includes('{')) continue;
    if (!pt.replace(/\{[A-Za-z][A-Za-z0-9]*\}/g, '').trim()) continue;
    const names = [];
    const pattern = new RegExp(`^${pt.split(/(\{[A-Za-z][A-Za-z0-9]*\})/g).map((part) => {
      const match = /^\{([A-Za-z][A-Za-z0-9]*)\}$/.exec(part);
      if (match) {
        names.push(match[1]);
        return capturePattern(match[1]);
      }
      return escapeRegExp(part);
    }).join('')}$`, 'u');
    const match = pattern.exec(line);
    if (!match) continue;
    const values = Object.fromEntries(names.map((name, index) => [name, match[index + 1]]));
    return en.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (placeholder, name) => values[name] ?? placeholder);
  }
  return undefined;
}

function translateTemplateFragments(line) {
  let result = line;
  for (const [, pt, en] of entries) {
    if (!pt.includes('{') || !pt.replace(/\{[A-Za-z][A-Za-z0-9]*\}/g, '').trim()) continue;
    const names = [];
    const fragments = pt.split(/(\{[A-Za-z][A-Za-z0-9]*\})/g);
    const source = fragments.map((part) => {
      const match = /^\{([A-Za-z][A-Za-z0-9]*)\}$/.exec(part);
      if (match) {
        names.push(match[1]);
        return capturePattern(match[1]);
      }
      return escapeRegExp(part);
    }).join('');
    const pattern = new RegExp(source, 'gu');
    result = result.replace(pattern, (...args) => {
      const captures = args.slice(1, 1 + names.length);
      const values = Object.fromEntries(names.map((name, index) => [name, captures[index]]));
      return en.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (placeholder, name) => values[name] ?? placeholder);
    });
  }
  return result;
}

export function catalogParity() {
  const enKeys = Object.keys(english).sort();
  const ptKeys = Object.keys(portuguese).sort();
  const keys = enKeys.length === ptKeys.length && enKeys.every((key, i) => key === ptKeys[i]);
  const placeholderParity = keys && enKeys.every((key) => placeholders(english[key]).join('\0') === placeholders(portuguese[key]).join('\0'));
  return { keys, placeholders: placeholderParity };
}

export function isUiLanguage(value) {
  return UI_LANGUAGES.includes(value);
}

export function languageName(language) {
  return language === 'pt-BR' ? 'Português (Brasil)' : 'English';
}

export function translate(language, key, params = {}) {
  const catalog = language === 'pt-BR' ? portuguese : english;
  const template = catalog[key] ?? english[key];
  if (typeof template !== 'string') return { text: 'Message unavailable in English.', usedFallback: true };
  const text = template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (match, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
  return { text, usedFallback: !Object.hasOwn(catalog, key) };
}

const likelyPortuguese = /\b(?:não|nao|sem|salvo|salva|contrato|verificação|verificações|escopo|escolha|explícita|rascunho|configuração|configurações|armado|desarmado|nenhum|nenhuma|fora|continuações|continuação|nada|escrever|escrito|falha|tentar|cancelar|criado|criada|alterado|autorizar|validação|ajuda|comando|projeto|última|atual|abrir|voltar|salvar|descartar|tela|interativo|liberado|liberada|candidata|candidatas|custo|risco|obrigatório|opcional|recomendado|sempre|válido|inválido|mudança|mudanças|veredito|relaxado|libera|executáveis|digite|enviar|escolha|persiste|persistente|validando|aguarde|pendente|efeito|salvo|salva|volta|rodada|sessão|arquivo|comandos|diretos|cliente|esperada|faltam|exports|interativo|navegar|escolher|editar|fechar|operaçao|operação|atender|escreve|capacidade|aproximado|declarado|declarada|mudou|motivo|travou|obrigatórios|passaram|nenhum|recomendada|validade|alcance|tempo|caminho|título|arquivo|confiável|idioma|preferência|somente|atual|pendente|chave|tradução|traduções|encontrar|falta|mensagem|mostrado|cliente|customizada|comandos|continua|seleção|atualizado|criação|criar|contratos|específico|aplicar|aplicada|salvar|falhou|gravação|permitido|permite|cancela|fechar|escolhido|obteve|decisão|nenhuma|está|estão|só|após|por|até|com|para|neste|nesta|do|da|dos|das|um|uma|outro|outra)\b/i;

export function resolveText(language, sourceText) {
  if (typeof sourceText !== 'string') return { text: sourceText, usedFallback: false };
  if (language === 'pt-BR') return { text: sourceText, usedFallback: false };
  const translated = sourceText.split('\n').map((line) => {
    const exactKey = sourceKeys.get(line);
    if (exactKey) return english[exactKey];
    const templated = translateTemplateLine(language, line);
    if (templated !== undefined) return templated;
    let result = translateTemplateFragments(line);
    for (const item of replacements) result = result.replaceAll(item.pt, item.en);
    if (likelyPortuguese.test(result)) return 'Message unavailable in English.';
    return result;
  });
  const text = translated.join('\n');
  return { text, usedFallback: text.includes('Message unavailable in English.') };
}

export function translateText(language, sourceText) {
  return resolveText(language, sourceText).text;
}

function invalidConfig() {
  return { language: 'en', warning: 'invalid' };
}

export async function loadProjectLanguage(root, trusted) {
  if (!trusted) return { language: 'en' };
  const path = await safePath(root, LANGUAGE_FILE);
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { language: 'en' };
    throw error;
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    return invalidConfig();
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return invalidConfig();
  if (!Object.hasOwn(config, 'uiLanguage')) return { language: 'en' };
  if (!isUiLanguage(config.uiLanguage)) return invalidConfig();
  return { language: config.uiLanguage };
}

export async function saveProjectLanguage(root, trusted, language) {
  if (!trusted) throw new Error('project-not-trusted');
  if (!isUiLanguage(language)) throw new Error('invalid-ui-language');
  const path = await safePath(root, LANGUAGE_FILE);
  try {
    const existing = JSON.parse(await readFile(path, 'utf8'));
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error('invalid-project-locale-file');
    if (Object.keys(existing).some((key) => key !== 'uiLanguage')) throw new Error('unknown-project-locale-field');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await atomicJson(path, { uiLanguage: language });
}
