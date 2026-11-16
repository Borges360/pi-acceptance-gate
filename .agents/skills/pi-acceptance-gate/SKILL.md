---
name: pi-acceptance-gate
description: Implementar e validar o Pi Acceptance Gate, seus contratos de tarefa, checkers, recibos e painéis /gate e /acceptance.
---

# Pi Acceptance Gate

Use esta especialização ao alterar ou verificar o projeto Pi Acceptance Gate. O catálogo comum continua vindo do workspace; estas regras descrevem somente o produto.

## Papel e limites

- O Gate avalia evidências de critérios de aceite de um projeto. Um resultado de checker não equivale a aprovação humana nem a aprovação do produto.
- `approve` exige justificativa humana; `--approve` autoriza apenas a execução dos checkers em modo headless, nunca substitui revisão humana.
- Preserve `definitionOfDone` ao validar, carregar e encaminhar o contrato.
- O comando raiz `/gate` abre o painel; `/acceptance` oferece criação guiada. Evite depender de outro checkout para funções básicas.
- Cancelar qualquer campo guiado deve terminar sem criar contrato, selecionar tarefa, gerar recibo ou alterar configuração.

## Mudanças no painel

- Preserve o contrato de rascunho: edição não salva; Ctrl+S valida e persiste; Esc volta, avisa sobre rascunho e permite descartá-lo.
- Operações têm sinal de cancelamento e cleanup. Resultado tardio não deve editar estado de outra sessão.
- Preserve os componentes, tema, largura e bindings nativos do Pi. Sanitização, erro e feedback devem ser localizados sem exibir caminhos ou conteúdo sensível.

## Verificação segura

- Use `npm test` para regressões unitárias. Os scripts `npm run smoke` e `npm run smoke:create` carregam o host Pi; antes de usá-los, confira os destinos de escrita e execute só com perfil temporário isolado, tarefas/recibos descartáveis, offline e sem ferramentas/MCP.
- Testes de checkers usam fixtures temporárias. Não execute contratos reais, APIs, processos permitidos ou aprovações reais como parte de um teste unitário.
- Ampliar `allowedExecutables` ou `allowedHosts`, invocar um checker real, gravar contrato/recibo real ou chamar modelo exige pedido e alvo explícitos.
- Não leia nem copie configuração, contratos, recibos ou dados de tarefa do perfil persistente do usuário para fixtures.
- O inventário não seleciona o INTEIRO para este produto; não anunciar adoção nem adicionar dependência visual por inferência.