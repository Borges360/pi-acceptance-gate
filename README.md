# pi-acceptance-gate

Aceitação por evidências para **Pi 1.1.0 / Node >=20**. A interface é um comando `/gate` e um status compacto. Não mantém o agente preso e não aceita uma tarefa por mera declaração da LLM.

```sh
npm ci --ignore-scripts --legacy-peer-deps
pi -e ./index.ts
```

## Definir pronto com `/acceptance create`

`/acceptance create` abre um diálogo para descrever o objetivo, escolher assistência,
revisar o template e o risco, responder perguntas com sugestões e editar o plano.
O resumo final mostra o YAML exato antes de criar e selecionar uma nova task em
`.pi/tasks/TASK-<uuid>.yaml`. Escape em qualquer etapa ou recusar o resumo cancela
sem criar contrato. Contratos existentes são preservados. Requer projeto confiável,
TUI/RPC e `acceptanceGate.enabled: true`; não inicia entrevistas automaticamente.

Os [templates públicos](templates/defaults.json) incluem correção de bug,
funcionalidade, documentação e início do zero. `/acceptance templates` lista as
opções. `/acceptance` também aceita os comandos de `/gate`, que continua compatível.

As regras locais funcionam sem modelo nem credenciais. Opcionalmente, escolha:

- **Decisões automáticas**: o classificador registrado no Pi (preferindo JEV)
  escolhe template e risco entre opções conhecidas. As recomendações aparecem
  primeiro e podem ser trocadas pelo usuário.
- **Perguntas personalizadas**: o modelo de chat atual do Pi sugere template,
  risco, perguntas, exemplos de resposta e passos específicos para o objetivo.

Essas opções usam a API nativa do `modelRegistry` quando disponível, sem serviço
ou extensão obrigatória adicional. Cada chamada envia somente o objetivo sanitizado,
tem limite de 15 segundos e aceita cancelamento. Respostas inválidas ou falhas
recaem explicitamente nas regras locais. O fluxo local funciona no host 1.1;
os recursos de modelos dependem das APIs `classify` / `complete` do host.

A task guarda `definitionOfDone` com objetivo, respostas, template, origem da
recomendação e plano. Esse contexto é apresentado ao agente quando a task está
selecionada e o gate está habilitado. Contratos antigos continuam válidos.
Perguntas viram critérios de revisão humana; um comando de teste pode ser informado
explicitamente, mas criar a task não executa checkers, não concede `arm` e não
aprova critérios. `/acceptance status` mostra a pendência; `/gate check` e
`/gate approve <justificativa>` mantêm suas autorizações e evidências habituais.

Validação sem credenciais: `npm test`. Para carregar o entry point pelo loader do
Pi instalado e percorrer a criação até o YAML: `node scripts/smoke-create.mjs`.
Se o host não estiver no resolvedor local, passe `--host-package <diretório-do-pacote>`.

## Contratos e comandos

`.pi/tasks/*.yaml` suporta` task` ou` tasks` (multitarefa). Compatibilidade com `.pi/acceptance.json`. Veja` examples/task.yaml`.

`/gate init`,` use TASK-ID`,` status`,` check`,` report`,` approve JUSTIFICATIVA`,` fail MOTIVO`,` arm`,` help`.

Autocomplete de argumentos nativo: `use` lista os contratos reais de `.pi/tasks/*.yaml` com risco, nº de checkers e qual está selecionado. Projeto não confiável diz isso (e por que a lista está vazia) em vez de oferecer nada.` approve` sem justificativa recusa explicando que a razão humana é o registro, não um checkbox.` status` agora diz o próximo passo (`/gate check`, evidência obsoleta, falta revisão humana) em vez de um JSON opaco. Um comando errado devolve a gramática inteira.

Máquina de estados: draft -> in_progress -> candidate -> verifying -> accepted/rejected/needs_human_review. Nova verificação cria outra tentativa; preserva recibos anteriores. Status accepted é invalidado por alteração de commit, contrato ou arquivos relevantes. Aprovação humana exige TUI/RPC, justificativa, HMAC local e TTL; é vinculada ao contrato, sessão e snapshot exatos. Não substitui um teste falho.

`arm` autoriza verificações automáticas do contrato atual por tempo limitado.` autoVerifyOnCandidate` e` continueForPendingChecks` são opt-in.` agent_before_settle` pede no máximo uma continuação limitada;` agent_settled` apenas mostra estado.` gate_check` executa checkers com confirmação/existente autorização, nunca toma decisão humana no lugar do usuário.

## Checkers

- Teste/processo, lint, build, static_analysis, idempotency: processo real sem interpolação de shell, allowlist de executáveis, cwd, timeout, aborto, limite de saída e exit code esperado. Idempotência é comprovada pelo **teste de integração indicado no contrato**, não inferida de logs.
- git_diff: caminhos permitidos/proibidos, incluindo untracked; tool_call bloqueia ferramentas/caminhos proibidos pelo contrato.
- file/documentation: existência/conteúdo e digest do artefato.
- coverage: executa comando e valida porcentagens no JSON de cobertura (formato Istanbul/total).
- vulnerability: executa scanner e valida severidades no JSON de auditoria quando configurado.
- api_contract: GET para host explicitamente permitido, status, chaves e JSON Schema de resposta (`responseSchema`, draft 2020-12); sem redirects. Contratos mais complexos podem usar checker de integração executável ou plugin` registerChecker`.
- human_review: confirmação humana; claim nunca satisfaz teste.

Recibos completos incluem hashes de comando/contrato/commit/árvore, timestamps, tipo/status, artefatos, digest, versão, ator e erro. Estados: pass, fail, skipped-with-reason, needs-human, not-run, inconclusive. Falhas, timeout e evidência obsoleta nunca viram pass. Artefatos de cobertura/reports/artifacts são excluídos do snapshot de código, mas seu digest é incluído no recibo.

## CI/headless

```sh
node cli.mjs --cwd /projeto --task TASK-001 --approve
```

`--approve` é autorização explícita de execução dos checkers, não aprovação humana de revisão. JSON no stdout; exit **0** accepted, **1** rejected, **2** not-run/erro de configuração, **3** needs-human. Não exige diálogo.` npm test` cobre processos reais, contratos, máquina de estados, caminhos e evidência inválida. Sem `--approve`, nenhum checker é executado.

## Persistência e segurança

JSON/JSONL sob `PI_SUITE_HOME/projects/<hash>`; **sem banco de dados**. Checkers são código confiável executado com permissões do usuário: cwd/allowlist não são um sandbox do SO. Revise scripts antes de autorizar. HMAC detecta adulteração casual; não protege contra outro processo com acesso à chave/mesmas permissões. Não grava saída integral de testes ou segredos.

Instalar/remover: `pi install ./pi-acceptance-gate` /` pi remove ./pi-acceptance-gate`. Não altera settings/modelos/MCP existentes.
# pi-acceptance-gate
