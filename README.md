# Pi Acceptance Gate

Evidence-based acceptance for Pi tasks. The root command opens an interactive gate; a model claim alone never accepts a task.

**Manifest:** `pi-acceptance-gate` · **version:** `0.3.0` · **manifest visibility:** `private: true`
**Registry status:** Availability/publication was not checked in this local documentation run. This README does not claim a registry release; CT59 owns registry verification and publication. The manifest is private. Its package file allowlist is limited to the Pi entry points, runtime modules, library code and docs/assets; local MCP, harness and test files are excluded from the tarball preview.
**Compatibility:** Node.js `>=20`; `package.json` declares Pi peer packages with wildcard versions. The documented minimum is Pi 1.1.0; the real-host smoke was observed on Pi 1.4.0.

## English

### What it does

Pi Acceptance Gate records evidence for a task and controls its acceptance lifecycle:

`draft → in_progress → candidate → verifying → accepted / rejected / needs_human_review`.

It can check tests and processes, lint/build, static analysis, idempotency, Git diffs, files/documentation, coverage, vulnerabilities and API contracts. The root command opens the panel and a compact status helps the agent continue without forcing a task to remain active. A human review remains distinct from automated checks. Updating the code, passing a test, or receiving a model claim does not by itself accept a task.

### Install and run locally

Registry installation is not documented because availability was not verified and the manifest marks this checkout private. From a local checkout, run:

```sh
npm ci --ignore-scripts --legacy-peer-deps
pi -e ./index.ts
```

In a source checkout, use `npm test` and `npm run smoke` for development checks. These test files and smoke scripts are not in the package file allowlist. The smoke loads the installed Pi host and TUI, drives the panel with terminal keys, and does not call a model.

### Use

Run `/gate` with no argument to open the panel. It shows the selected task, scope, checker counts and continuation limit. Use ↑/↓ to navigate, Enter to edit or open a submenu, and Esc to return or close. Selecting a configuration value currently writes it immediately; this version has no unsaved settings draft or Ctrl+S save step. That describes current behavior and does not claim compliance with the draft/save UX standard.

The panel's selectable fields and values come from the exported FIELDS table in menu.mjs. The text command and panel both use applyField, so they share validation instead of maintaining separate lists. This prevents a menu from offering a value the command layer refuses. A similar mismatch in selected-as was previously found in another extension and is documented here as a regression lesson.

Commands include `status`, `use TASK-ID`, `init [TASK-ID]`, `check`, `report`, `approve JUSTIFICATION`, `fail REASON`, `arm [once|15min|1h|8h|always]`, `arm-off`, `scope available|declared`, `strict on|off`, `ttl 15min|1h|8h`, `arm-scope once|ttl|always`, `revisions 0|1|2|3`, `auto-select on|off`, `autoverify on|off`, `continue on|off`, `on`, `off`, `allow exe|host VALUE`, `deny exe|host VALUE`, and `help`.

`use` lists actual contracts from `.pi/tasks/*.yaml`. The task format accepts either `task` or `tasks` and remains compatible with `.pi/acceptance.json`. `approve` requires a human justification; `--approve` in headless mode authorizes checker execution only, not human review.

### Configuration and state

Project configuration is stored by Pi in `.pi/pi-suite.yaml`. The `acceptanceGate` section supports:

| Setting | Default | Effect and caution |
| --- | --- | --- |
| `enabled` | `true` | Enables the gate for the project. |
| `autoSelect` | `true` | Selects only when a single task or a clear diff match exists; ties remain unselected. |
| `autoVerifyOnCandidate` | `false` | Runs checks for a candidate only when the gate is armed. |
| `continueForPendingChecks` | `false` | Requests another round for pending evidence unless Longrun owns the current execution or a continuation is already requested. |
| `maxAutoRevisions` | `2` | The effective continuation ceiling is `min(1, contract, config)`. |
| `armScope` | `ttl` | `once` ends after one check; `always` does not expire. |
| `approvalTtlSeconds` | `900` | Approval/arm window; the panel offers 15 minutes, 1 hour, or 8 hours. |
| `scope.source` | `available` | Uses current session capabilities; `declared` requires every declared criterion. |
| `scope.strict` | `true` | Keeps required out-of-scope criteria blocking; turning it off can remove required checks. |
| `allowedExecutables` | `node, npm, mvn, mvnw, gradle, gradlew, go, dotnet, pytest, terraform` | Allowlist for process checkers. Widening it is a security change. |
| `allowedHosts` | `[]` | Hosts allowed for API-contract checkers. Widening it is a security change. |
| `ignorePaths` | `.pi/tasks/**, .pi/acceptance.json` | Excludes these paths from code snapshots; report digests remain recorded. |

A global policy may lock fields under `locked.acceptanceGate.*`; a locked or invalid value is rejected. Widening executable/host permissions asks for confirmation and is written to the project configuration, not the global settings.

Evidence and receipts are stored as JSON/JSONL beneath `PI_SUITE_HOME/projects/<project-hash>`. The gate uses local files, not a database. An accepted state becomes stale when the commit, contract or relevant files change.

### Language

This README is bilingual, with English first and Brazilian Portuguese as the project-level documentation preference. The current extension labels are in Brazilian Portuguese. There is no runtime language selector or persisted locale preference in this artifact.

### Privacy and security

The gate does not call a model to decide acceptance. Checkers run as trusted code with the user's operating-system permissions; a project allowlist is not an OS sandbox. API-contract checkers can contact only explicitly allowed hosts and do not follow redirects. Review checker scripts before arming them.

The smoke uses synthetic task data and no model. The extension avoids retaining complete test output or secret values. Local HMAC detects casual receipt tampering, but does not protect against another process with access to the same key and permissions.

### Troubleshooting and limits

- `mvn-not-installed`: the executable is missing from PATH; install it or choose `/gate scope declared` if that matches the task policy.
- `exe-not-allowlisted:<name>`: request the project-level `/gate allow exe <name>` permission after review.
- `host-not-allowlisted:<host>`: review the task and then allow the host at project scope if required.
- `artifact-missing`, `checker-timeout`, and `checker-error` describe evidence or execution failures; they are not reclassified as out-of-scope.
- `--approve` authorizes automated checker execution only. It does not replace a human reviewer.
- The current UI persists configuration edits immediately; it does not yet provide a draft that is saved with Ctrl+S and discarded with Esc.

Headless usage:

```sh
node cli.mjs --cwd /path/to/project --task TASK-001 --approve
```

Exit codes: `0` accepted, `1` rejected, `2` not-run/configuration error, `3` needs human review.

### Host integration and checks

The entry point statically imports pi-tui and pi-coding-agent and passes those host modules to the panel factory. Pi's jiti loader maps these host modules for static imports; a dynamic import from inside the extension would use Node's resolver and can fail with `MODULE_NOT_FOUND`. Direct loading of extension.mjs has a named fallback that reports a missing export instead of failing silently. The real-host smoke checks the exported module shape against the installed Pi release.

The smoke command loads index.ts through Pi's own extension loader, opens the empty /gate command, moves through the panel with terminal key bytes, opens the task submenu, closes the panel, and records the before/after choice. The submenu navigation selects and activates the item in one step. Exit code 0 confirms the scripted real-host interaction; it is not a human visual review. No model is called.

Task files under .pi/tasks/*.yaml accept either task or tasks and remain compatible with .pi/acceptance.json. The use command lists actual task contracts with risk and checker counts. An untrusted project gets an explanation instead of an offered list. Approval receipts bind the human justification to the contract, session, and snapshot with a local HMAC and TTL; a new check creates another attempt and retains earlier receipts.

Checker types include real process execution without shell interpolation; Git path checks including untracked files; file/documentation digests; coverage thresholds read from Istanbul JSON; vulnerability severities read from configured audit JSON; API GET checks against explicitly allowed hosts without redirects; and explicit human review. The gate records complete receipt metadata and does not convert failures, timeouts, or stale evidence into a pass.

### License

No product `LICENSE` file or license field is present in this checkout; confirm the product's license before redistribution. The bundled INTEIRO mark has a separate MIT notice in [docs/assets/INTEIRO-MARK-LICENSE.txt](docs/assets/INTEIRO-MARK-LICENSE.txt).

## Português (Brasil)

### O que faz

O Pi Acceptance Gate registra evidências de uma tarefa e controla seu ciclo de aceite:

`draft → in_progress → candidate → verifying → accepted / rejected / needs_human_review`.

Ele verifica testes e processos, lint/build, análise estática, idempotência, diffs Git, arquivos/documentação, cobertura, vulnerabilidades e contratos de API. O comando raiz abre o painel e um status compacto ajuda a continuidade do agente sem mantê-lo preso a uma tarefa. Revisão humana continua separada das verificações automáticas. Alterar código, passar num teste ou receber uma afirmação do modelo não aceita uma tarefa por si só.

### Instalação e uso local

Não documentamos instalação pelo registry: a disponibilidade não foi verificada e o manifesto marca este checkout como privado. A partir de um checkout local:

```sh
npm ci --ignore-scripts --legacy-peer-deps
pi -e ./index.ts
```

Para desenvolvimento, execute `npm test` e `npm run smoke`. O smoke carrega o host e o TUI instalados do Pi, navega pelo painel com teclas de terminal e não chama um modelo.

### Uso

Execute `/gate` sem argumento para abrir o painel. Ele mostra a tarefa selecionada, o escopo, a quantidade de checkers e o limite de continuações. Use ↑/↓ para navegar, Enter para editar ou abrir um submenu e Esc para voltar ou fechar. No comportamento atual, selecionar uma configuração grava o valor imediatamente; esta versão não tem rascunho de configuração nem etapa de salvar com Ctrl+S. Esta descrição registra o comportamento atual e não afirma conformidade com o padrão de UX de rascunho/salvamento.

Os campos e valores selecionáveis do painel vêm da tabela FIELDS exportada por menu.mjs. O comando de texto e o painel usam applyField, compartilhando a validação em vez de manter listas separadas. Assim o painel não oferece um valor que a camada de comando recusaria. Uma divergência semelhante em selected-as foi encontrada anteriormente em outra extensão e fica registrada como aprendizado de regressão.

Os comandos incluem `status`, `use TASK-ID`, `init [TASK-ID]`, `check`, `report`, `approve JUSTIFICATIVA`, `fail MOTIVO`, `arm [once|15min|1h|8h|always]`, `arm-off`, `scope available|declared`, `strict on|off`, `ttl 15min|1h|8h`, `arm-scope once|ttl|always`, `revisions 0|1|2|3`, `auto-select on|off`, `autoverify on|off`, `continue on|off`, `on`, `off`, `allow exe|host VALOR`, `deny exe|host VALOR` e `help`.

`use` lista contratos existentes em `.pi/tasks/*.yaml`. O formato aceita `task` ou `tasks` e continua compatível com `.pi/acceptance.json`. `approve` exige justificativa humana; em modo headless, `--approve` autoriza apenas executar os checkers, não substitui a revisão humana.

### Configuração e estado

A configuração do projeto é armazenada pelo Pi em `.pi/pi-suite.yaml`. A seção `acceptanceGate` oferece:

| Configuração | Padrão | Efeito e cuidado |
| --- | --- | --- |
| `enabled` | `true` | Habilita o gate no projeto. |
| `autoSelect` | `true` | Seleciona somente quando há uma tarefa única ou correspondência clara com o diff; empates ficam sem seleção. |
| `autoVerifyOnCandidate` | `false` | Verifica uma candidata somente se o gate estiver armado. |
| `continueForPendingChecks` | `false` | Solicita outra rodada para evidências pendentes quando o Longrun não gerencia a execução atual e nenhuma continuação foi solicitada. |
| `maxAutoRevisions` | `2` | O teto efetivo é `min(1, contrato, configuração)`. |
| `armScope` | `ttl` | `once` termina após uma verificação; `always` não expira. |
| `approvalTtlSeconds` | `900` | Janela de autorização; o painel oferece 15 minutos, 1 hora ou 8 horas. |
| `scope.source` | `available` | Usa as capacidades da sessão; `declared` exige todos os critérios declarados. |
| `scope.strict` | `true` | Mantém critérios obrigatórios sem escopo como bloqueadores; desligar isso pode remover verificações obrigatórias. |
| `allowedExecutables` | `node, npm, mvn, mvnw, gradle, gradlew, go, dotnet, pytest, terraform` | Lista de processos permitidos. Ampliá-la é uma mudança de segurança. |
| `allowedHosts` | `[]` | Hosts permitidos para checkers de API. Ampliá-la é uma mudança de segurança. |
| `ignorePaths` | `.pi/tasks/**, .pi/acceptance.json` | Exclui caminhos dos snapshots de código; digests dos relatórios continuam registrados. |

Uma política global pode travar campos em `locked.acceptanceGate.*`; valores travados ou inválidos são recusados. Ampliar as permissões de binários ou hosts exige confirmação e grava na configuração do projeto, nunca nas configurações globais.

Evidências e recibos ficam em JSON/JSONL sob `PI_SUITE_HOME/projects/<hash-do-projeto>`. O gate usa arquivos locais, sem banco de dados. Um estado `accepted` fica obsoleto quando mudam o commit, o contrato ou arquivos relevantes.

### Idioma

Este README é bilíngue, com inglês primeiro e português brasileiro como preferência de documentação do projeto. Os rótulos atuais da extensão estão em português brasileiro. Este artefato não implementa seletor de idioma nem preferência de localidade persistida.

### Privacidade e segurança

O gate não usa modelo para decidir o aceite. Checkers são código confiável e executam com as permissões do sistema operacional do usuário; uma allowlist do projeto não é sandbox do sistema. Checkers de contrato de API podem consultar somente hosts explicitamente permitidos e não seguem redirecionamentos. Revise scripts dos checkers antes de armá-los.

O smoke usa tarefas sintéticas e não chama modelo. A extensão evita reter a saída integral dos testes e valores de segredos. O HMAC local detecta adulteração casual de recibos, mas não protege contra outro processo com acesso à mesma chave e às mesmas permissões.

### Diagnóstico e limites

- `mvn-not-installed`: o executável não está no PATH; instale-o ou use `/gate scope declared` quando isso corresponder à política da tarefa.
- `exe-not-allowlisted:<nome>`: após revisão, solicite a permissão de projeto com `/gate allow exe <nome>`.
- `host-not-allowlisted:<host>`: revise a tarefa e permita o host no projeto somente se necessário.
- `artifact-missing`, `checker-timeout` e `checker-error` indicam falha de evidência ou execução; não são reclassificados como fora do escopo.
- `--approve` autoriza somente a execução dos checkers. Não substitui a revisão humana.
- A interface grava edições de configuração imediatamente; ainda não oferece um rascunho salvo com Ctrl+S e descartado com Esc.

Uso headless:

```sh
node cli.mjs --cwd /caminho/do/projeto --task TASK-001 --approve
```

Códigos de saída: `0` accepted, `1` rejected, `2` not-run/erro de configuração, `3` precisa de revisão humana.

### Integração com o host e verificações

O entry point importa pi-tui e pi-coding-agent estaticamente e entrega esses módulos do host à fábrica do painel. O loader jiti do Pi mapeia esses módulos para imports estáticos; um import dinâmico dentro da extensão usa o resolvedor do Node e pode falhar com `MODULE_NOT_FOUND`. O carregamento direto de extension.mjs tem um fallback que identifica o export ausente em vez de falhar em silêncio. O smoke no host real confere os exports com a versão instalada do Pi.

O smoke carrega index.ts pelo loader do próprio Pi, abre o comando /gate vazio, navega pelo painel com bytes de teclado, abre o submenu de tarefas, fecha o painel e registra a seleção antes e depois. Navegar até o submenu seleciona e ativa o item numa etapa. Exit code 0 confirma a interação automatizada com o host; não equivale a uma revisão visual humana. Nenhum modelo é chamado.

Arquivos de tarefa em .pi/tasks/*.yaml aceitam task ou tasks e continuam compatíveis com .pi/acceptance.json. O comando use lista contratos existentes com risco e quantidade de checkers. Um projeto não confiável recebe uma explicação em vez de uma lista de tarefas. Recibos de aprovação vinculam a justificativa humana ao contrato, sessão e snapshot por HMAC local e TTL; cada nova verificação cria outra tentativa e preserva os recibos anteriores.

Os tipos de checker incluem execução de processos reais sem interpolação de shell; validação de caminhos Git, inclusive arquivos não rastreados; digests de arquivos/documentação; limites de cobertura lidos de JSON Istanbul; severidades de vulnerabilidade lidas do JSON de auditoria configurado; verificações GET de API contra hosts explicitamente permitidos e sem redirecionamentos; e revisão humana explícita. O gate registra os metadados completos do recibo e não converte falhas, timeouts ou evidências obsoletas em aprovação.

### Licença

Este checkout não tem arquivo `LICENSE` nem campo de licença no manifesto do produto; confirme a licença antes de redistribuí-lo. A marca INTEIRO tem aviso MIT separado em [docs/assets/INTEIRO-MARK-LICENSE.txt](docs/assets/INTEIRO-MARK-LICENSE.txt).
