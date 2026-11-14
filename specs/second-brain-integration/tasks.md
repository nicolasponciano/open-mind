# Tarefas: Integração do Segundo Cérebro

- [x] T-01 Criar testes PowerShell com fixtures isoladas para `-WhatIf`, validação, idempotência e preservação (RF-01, RF-02, RF-05).
- [x] T-02 Promover a lógica de estrutura a `scripts/setup-vault.ps1`, mantendo uma única lista de pastas e sem escrever constituição (RF-02, RF-03).
- [x] T-03 Implementar `scripts/bootstrap.ps1` com modos de instalação/validação/reconexão/atualização planejada, validação e `ShouldProcess` (RF-01, RF-04, RF-05).
- [x] T-04 Documentar instalação após formatação, limites sem vault, conexão OpenCode e restauração de dados condicionada a backup (RF-01, RF-04).
- [x] T-05 Executar testes PowerShell e `npm run check`; corrigir regressões e revisar a lista de alterações sem acessar dados reais (RF-01 a RF-05).
- [x] T-06 Corrigir `Restore` para distinguir `RECONNECT_READY` de `RECONNECT_INCOMPLETE`, rejeitar caminhos drive-relativos e integrar os testes PowerShell ao `npm run check` com skip quando não houver PowerShell (RF-04, RF-05).

## Dependências externas
- Definição de backup e aprovação para qualquer alteração no vault real ou configuração global não bloqueiam os testes isolados, mas são necessárias para restauração dos dados e reconexão aplicada.
