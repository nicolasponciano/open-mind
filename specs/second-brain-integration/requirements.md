# Requirements: Integração do Segundo Cérebro

## Visão geral
Integrar o vault Obsidian existente ao Open-mind-system e tornar a infraestrutura reconstruível a partir do repositório. O bootstrap deve funcionar mesmo sem o vault local, sem tentar reconstruir notas ou constituição. Operações reais de conexão e escrita continuam sujeitas à aprovação.

## Problema
Hoje o setup de pastas existe somente no `setup-vault.ps1` do vault Obsidian existente, enquanto o repositório configura e executa o plugin. Após formatação, o ambiente pode ser reconstruído independentemente dos dados, mas não há uma entrada versionada que valide e conecte essas partes sem depender do vault.

## Funcionalidades

### RF-01 Bootstrap independente do vault
Disponibilizar `scripts/bootstrap.ps1` no repositório como ponto de entrada para instalar/verificar pré-requisitos, validar o clone, planejar configuração e preparar a reconexão de um vault quando seu caminho for fornecido. `Restore` nesta versão apenas valida um vault que já foi recuperado por outro meio e prepara sua reconexão; não recupera dados. O modo sem vault valida somente código e infraestrutura.
Critérios de aceite:
- CA-01: Executar o bootstrap sem caminho de vault não cria diretórios de conhecimento e informa claramente que a recuperação dos dados depende de uma fonte de backup/restauração externa.
- CA-02: `-WhatIf` mostra as operações previstas sem executar alterações no repositório, vault ou configuração global.
- CA-03: O bootstrap valida caminhos absolutos existentes quando a operação exigir vault e falha de forma explícita diante de caminho inválido.
- CA-04: Repetir validação/bootstrap não cria arquivos duplicados nem altera arquivos existentes sem autorização.

### RF-02 Inicialização da estrutura do vault
Manter `scripts/setup-vault.ps1` como mecanismo responsável exclusivamente pela estrutura interna, com `inbox/`, `diario/`, `pessoas/`, `empresas/`, `clientes/`, `reunioes/`, `deals/`, `financas/`, `projetos/`, `conteudo/`, `conhecimento/`, `pessoal/`, `referencias/`, `arquivo/`, além de `conteudo/ideias/`, `conhecimento/raw/` e `conhecimento/wiki/`. A lógica de criação existe em uma única implementação versionada e é chamada pelo bootstrap. A cópia atual no vault real permanece intocada.
Critérios de aceite:
- CA-05: A rotina cria apenas pastas ausentes e mantém arquivos, constituição e convenções já existentes.
- CA-06: Rodar a rotina duas vezes produz o mesmo estado após a primeira execução.
- CA-07: Um vault com estrutura não canônica é diagnosticado; nenhuma pasta paralela é criada e nenhuma migração automática é aplicada.
- CA-08: O bootstrap chama a rotina versionada; não contém uma segunda lista/implementação de criação das pastas.

### RF-03 Preservação do contexto e roteamento
Manter o `AGENTS.md` real como fonte canônica de roteamento em uso. O código e instruções auxiliares devem consumir/referenciar essa constituição e não replicar a tabela em fontes independentes. Esta implementação não gera nem edita `AGENTS.md`, mesmo quando ausente.
Critérios de aceite:
- CA-09: A rotina de estrutura não cria, substitui nem edita `AGENTS.md`, existente ou ausente.
- CA-10: Não há uma nova tabela de roteamento duplicada no bootstrap, Core ou skill.
- CA-11: Busca, leitura, contexto de projeto e as seis ferramentas atuais mantêm nomes e comportamento compatíveis.

### RF-04 Restauração e conexão controladas
Separar reconstrução de código/infraestrutura da recuperação de dados. O modo `Restore` apenas valida um vault previamente recuperado e prepara o plano de conexão local. Não baixa, restaura nem sincroniza dados. Mudanças na configuração global do OpenCode são apenas planejadas até aprovação explícita.
Critérios de aceite:
- CA-12: Com vault preservado, são verificados diretório, arquivos-base e convenções sem escrever neles.
- CA-13: Sem vault local, o modo `Restore` informa que nenhum dado foi restaurado e que é necessária uma fonte de dados recuperada; não inicia configuração de conteúdo ou briefing do zero.
- CA-14: Configuração global e vault real não são alterados por testes nem pelo modo padrão do bootstrap.
- CA-15: A documentação diferencia código/infraestrutura, dados/contexto e segredos, sem versionar credenciais.
- CA-19: `Restore` só emite `RECONNECT_READY` quando o diretório existe e `AGENTS.md` e `00 - Open Mind.md` estão presentes; caso contrário emite `RECONNECT_INCOMPLETE` sem criar arquivos ou diretórios.

### RF-05 Escrita segura e recuperação de falhas
Preservar política `disabled`/`best-effort`, autorização por ação, criação sem sobrescrita e atualização com `expectedHash`. Operações parciais devem relatar o estado e parar sem tentativa automática de apagar ou reverter dados.
Critérios de aceite:
- CA-16: Regressão automatizada confirma autorização e `expectedHash` das ferramentas existentes.
- CA-17: Caminhos inválidos, traversal ou destinos fora da raiz são rejeitados antes de qualquer escrita.
- CA-18: Falha parcial de bootstrap não remove dados nem arquivos prévios e produz diagnóstico sem segredos.
- CA-20: Caminhos relativos a drive (ex.: `C:rel`) e caminhos relativos comuns são rejeitados por `bootstrap.ps1` e `setup-vault.ps1` antes de qualquer leitura ou escrita.

## Fora de escopo
- Backup, sincronização, upload ou restauração de dados de provedores externos.
- Geração automática ou edição do `AGENTS.md`.
- Edição do vault real, `AGENTS.md` personalizado ou configuração global sem aprovação específica.
- Reescrita do Core, mudança das seis ferramentas, criação de um segundo vault ou migração automática de convenções.
- Instalação de plugins Obsidian, templates, Dataview ou automações não necessárias.

## Impacto no que já existe
- Preservar `src/core/open-mind-core.ts`, `src/filesystem/vault-files.ts`, `src/tools/open-mind-tools.ts` e `src/adapters/opencode/adapter.ts`; mudanças só se auditoria/testes provarem necessidade.
- Adicionar scripts versionados, documentação de instalação/recuperação e testes PowerShell com fixtures temporárias.
- O `setup-vault.ps1` atualmente existente no vault real não será alterado nesta evolução sem autorização; a versão versionada será testada isoladamente.
- Vaults com estrutura não canônica serão apenas diagnosticados; não haverá criação de árvore paralela, movimentação ou migração automática.
- Risco principal: divergência temporária entre a cópia real e a versão versionada do setup até aprovação para atualizar o vault.

## Decisões em aberto
- Estratégia e localização de backup persistente: fora desta implementação; restauração de dados só será declarada quando uma fonte acessível for definida.
- Autorização futura para atualizar/substituir o script `setup-vault.ps1` dentro do vault real: necessária antes dessa operação.
