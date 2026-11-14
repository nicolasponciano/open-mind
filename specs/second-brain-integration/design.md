# Design: Integração do Segundo Cérebro

## Stack
PowerShell para bootstrap no Windows atual; TypeScript/Node.js e `node:test` para o plugin existente. Sem novas dependências de runtime.

## Dados
- Infraestrutura versionada: scripts, documentação, testes e configuração de exemplo não secreta.
- Dados privados: vault Markdown, notas, links, `AGENTS.md` personalizado e histórico; fora do repositório.
- Segredos: variáveis de ambiente ou armazenamento local protegido; nunca copiados pelo bootstrap para arquivos versionados.

## Componentes e fluxos
- `scripts/bootstrap.ps1`: ponto único para `Install`, `Validate`, `Restore` e `Update` planejado. `Restore` apenas valida um vault previamente recuperado e prepara sua reconexão; não recupera dados. Trabalha a partir da raiz do repositório; sem vault, limita-se à infraestrutura. Aceita `-VaultPath`, `-Mode` e `-WhatIf`/`ShouldProcess`; a configuração global só é exibida como plano, nunca alterada implicitamente.
- `scripts/setup-vault.ps1`: única implementação versionada da criação idempotente da estrutura de pastas. Responsável apenas por diretórios ausentes; não cria nem substitui `AGENTS.md`, mapas, notas ou conteúdo. O bootstrap a invoca quando `VaultPath` foi validado e a operação foi aprovada.
- `setup-vault.ps1` no vault Obsidian existente: script atualmente no vault; não é dependência para reconstruir o repositório e não será alterado sem aprovação. A cópia versionada é a implementação a testar e usar via bootstrap; eventual reconciliação da cópia real fica para etapa autorizada.
- Core/Bridge: seguem responsáveis por acesso ao vault, busca/leitura, isolamento de caminho e escrita controlada. A camada de agentes usa `AGENTS.md` para classificação contextual; bootstrap não implementa roteamento.
- OpenCode: conexão é preparada por instrução/patch de configuração revisável. Não mesclar automaticamente em `opencode.jsonc` global; valores secretos não são emitidos.

## Evitar dependência circular
O repositório contém todo código necessário para validar e reconstruir a infraestrutura, incluindo o script de setup. O bootstrap não importa instruções nem executáveis do vault para iniciar. Se o vault estiver disponível, recebe seu caminho como entrada de dados e o script versionado aplica somente a estrutura ausente. O vault não precisa conter nem instalar o repositório para que a infraestrutura seja validada. Recuperação de notas exige restaurar uma fonte de dados independente; clonar o código nunca é apresentado como restauração do cérebro.

## Decisões técnicas
- Promover a lógica de setup existente para uma implementação versionada em `scripts/setup-vault.ps1`; não repetir a lista de pastas no bootstrap. O script no vault permanece intacto até autorização.
- Usar `SupportsShouldProcess`/`-WhatIf` em todas as ações mutáveis. Por padrão, validação e planejamento são seguros; escritas em configurações reais exigem confirmação e opt-in explícito.
- Preservar pastas desconhecidas e personalizações; vault não canônico é diagnosticado sem criar estruturas paralelas ou migrar automaticamente. Produzir relatório em vez de mover dados.
- Usar diretórios temporários em testes; nenhum teste lê/escreve no vault pessoal ou na configuração global.
- Nenhum modo de backup ou sincronização é implementado enquanto a estratégia de persistência não for definida.

## Segurança e permissões
- Validar raiz do repositório e `VaultPath`; rejeitar vazio, relativo quando caminho absoluto for requerido, raiz inexistente/inacessível e destinos perigosos.
- Não permitir saída da raiz validada, nem executar operações do vault sem path explícito e confirmação para mutação.
- Logs descrevem ação/resultado, nunca conteúdo de notas, tokens, credenciais ou caminhos secretos além do necessário localmente.
- Não alterar `writePolicy`, não contornar `ctx.permission.assert`, não remover o `expectedHash` nem habilitar escrita pelo bootstrap.

## Plano de testes
- Pester (se já disponível) para scripts PowerShell, sem dependência obrigatória nova; se ausente, testes PowerShell executáveis no ambiente CI/documentados e fixtures temporárias.
- Casos cobrem vault ausente, existente, não canônico, idempotência, `-WhatIf`, não criação de `AGENTS.md`, caminhos fora da raiz, erro parcial, plano sem configuração global e `Restore` sem fonte recuperada.
- `npm run check` mantém cobertura das seis ferramentas e das proteções do Core.

## Riscos e dependências
- PowerShell e políticas de execução variam entre máquinas; bootstrap deve detectar versão incompatível e explicar como executar sem reduzir políticas globalmente.
- O ambiente global do OpenCode e os dados do vault não são restauráveis a partir do Git sem backup independente.
- A cópia atual de `setup-vault.ps1` no vault pode divergir da implementação versionada até a aprovação de atualização.
