# Bootstrap e recuperação do ambiente

O bootstrap reconstrói e valida a **infraestrutura**, não o conteúdo pessoal. O repositório contém o plugin Open Mind, seus testes e os scripts. Notas, links e `AGENTS.md` personalizado permanecem no vault Obsidian; segredos permanecem em armazenamento local seguro/variáveis de ambiente. Git não é backup do vault.

## Depois de uma formatação

1. Instale PowerShell 5.1 ou superior e Node.js 24 ou superior.
2. Clone o repositório e abra PowerShell na raiz do clone.
3. Valide o ambiente sem informar vault:

   ```powershell
   .\scripts\bootstrap.ps1 -Mode Validate
   ```

   Sem vault, o comando valida apenas o repositório e os pré-requisitos. Não cria um vault, notas ou `AGENTS.md` e não declara os dados recuperados.

4. Restaure o vault por uma fonte de dados que você tenha escolhido e validado independentemente. Este projeto não configura backup, sincronização ou download de dados.
5. Valide e prepare a reconexão ao vault já recuperado:

   ```powershell
   .\scripts\bootstrap.ps1 -Mode Restore -VaultPath "D:\Vaults\MeuVault"
   ```

   `Restore` apenas confere o diretório, os arquivos-base e a estrutura. Ele não recupera dados, não cria pastas e não altera a configuração global do OpenCode. Um caminho inexistente resulta em `DATA_NOT_RESTORED`; um vault sem `AGENTS.md` ou `00 - Open Mind.md` resulta em `RECONNECT_INCOMPLETE`. Somente com os dois arquivos-base presentes a saída é `RECONNECT_READY`.

6. Revise a saída e conecte o plugin manualmente na configuração do OpenCode. Mescle o objeto abaixo em `plugins`, preservando todas as entradas e propriedades existentes. Use `writePolicy: "disabled"` inicialmente. Não copie credenciais para o repositório.

   ```jsonc
   {
     "package": "<caminho-absoluto-para-o-clone>/open-mind-system",
     "options": {
       "vaultPath": "<caminho-absoluto-para-o-vault-recuperado>",
       "writePolicy": "disabled"
     }
   }
   ```

## Modos

- `Validate` (padrão): valida o repositório; com `-VaultPath`, inspeciona a estrutura sem gravar.
- `Install`: valida o clone e mostra instruções de conexão. Com `-VaultPath`, inspeciona o destino. A criação de diretórios exige o opt-in `-InitializeVault`.
- `Restore`: valida apenas um vault que já foi recuperado e prepara a reconexão. Não é mecanismo de recuperação de dados. Saídas possíveis: `RECONNECT_READY` (estrutura, `AGENTS.md` e `00 - Open Mind.md` presentes), `RECONNECT_INCOMPLETE` (arquivos-base ausentes, nada é criado), `DATA_NOT_RESTORED` (caminho inexistente ou ausente).
- `Update`: informa que não há migrações versionadas; não aplica mudanças.
- `-WhatIf`: simula qualquer criação de pastas; nenhuma pasta é criada.

O caminho do vault deve ser absoluto e totalmente qualificado; caminhos relativos a drive (`C:rel`) e caminhos relativos comuns são rejeitados antes de qualquer operação. O diretório precisa existir. O bootstrap não cria a raiz escolhida. Estruturas não canônicas são diagnosticadas; o sistema não cria uma árvore paralela nem move arquivos automaticamente.

Em `Validate` e `Restore`, as linhas `What if:` vêm da simulação da estrutura e existem apenas para mostrar o que seria criado; nada é gravado.

## Inicializar apenas a estrutura

Para um vault novo já criado pelo usuário, primeiro simule:

```powershell
.\scripts\bootstrap.ps1 -Mode Install -VaultPath "D:\Vaults\MeuVault" -InitializeVault -WhatIf
```

Depois de revisar o plano, execute explicitamente:

```powershell
.\scripts\bootstrap.ps1 -Mode Install -VaultPath "D:\Vaults\MeuVault" -InitializeVault
```

O bootstrap delega a única lista de pastas versionada a `scripts/setup-vault.ps1`. Esse script cria somente diretórios ausentes. Não cria/edita `AGENTS.md`, mapas ou notas. A cópia histórica `setup-vault.ps1` dentro do vault existente não é substituída por estes comandos.

## Testes isolados

Os testes PowerShell usam fixtures temporárias e não acessam o vault pessoal nem a configuração global:

```powershell
npm run test:powershell
npm run check
```

`npm run check` executa os testes Node, os testes PowerShell e o typecheck. O runner `scripts/run-powershell-tests.mjs` procura `pwsh` e, depois, `powershell`; se nenhum existir, imprime `SKIP` e encerra com sucesso, para não quebrar ambientes sem PowerShell.

`-ExecutionPolicy Bypass` vale somente para o processo iniciado pelo runner; não altera a política da máquina. O modo de simulação recomendado para avaliar um destino é `-WhatIf`.

Testes Node ignorados nesta plataforma e risco residual:

- `permite symlink para dentro do Vault e bloqueia link para fora` e `revalida caminhos após alteração para symlink externo`: exigem privilégio para criar symlink de arquivo no Windows; ficam ignorados quando o sistema retorna `EPERM`/`EACCES`/`ENOTSUP`. Risco residual: contenção de link simbólico de arquivo não é exercitada nesta máquina; o caso de diretório (junction) permanece coberto e passa.
- `detecta troca do diretório pai após criar o temporário e limpa o temporário`: o Windows não permite renomear o diretório enquanto o temporário está aberto. Risco residual: a janela de corrida TOCTOU não é provada aqui; testes vizinhos de concorrência e de pai redirecionado continuam cobrindo o comportamento esperado.

## Limites de recuperação

O Git recupera código e documentação não secreta. Não recupera notas, relacionamentos, constituição personalizada, configuração global do OpenCode nem credenciais. Para recuperar o Segundo Cérebro após perda do disco, é necessária uma cópia de dados acessível e validada, cuja estratégia ainda precisa ser definida pelo usuário. Nenhuma sincronização externa é iniciada pelo bootstrap.
