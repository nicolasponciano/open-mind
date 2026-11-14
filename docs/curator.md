# Curador do Segundo Cérebro

O curador analisa o contexto de uma sessão, propõe notas reutilizáveis e só grava no vault depois de confirmação explícita do usuário, por lote e por item. Ele não é um novo sistema de persistência: reaproveita o vault Markdown, o roteamento do `AGENTS.md` e as áreas canônicas do Segundo Cérebro.

## Arquivos versionados

| Arquivo | Papel |
|---|---|
| `agents/cerebro-curador.md` | Subagente que analisa e propõe. Fonte canônica. |
| `scripts/cerebro_curador.py` | Script que valida, mantém as prévias e grava. Fonte canônica. |
| `tests/curator/test_curator.py` | Testes com vaults fictícios. |
| `scripts/bootstrap.ps1` | Instalação opcional e idempotente. |

Os originais fora do repositório (`%USERPROFILE%\.config\opencode\agents\` e `%USERPROFILE%\.agents\scripts\`) são cópias. Depois da instalação, o repositório é a versão canônica: altere aqui e reinstale.

O OpenCode descobre subagentes em `.opencode/agents` (projeto) ou `~/.config/opencode/agents` (global) e não oferece uma opção de configuração para apontar a um arquivo fora desses diretórios. Por isso a instalação copia o agente e o script; não existe cópia paralela com outro conteúdo.

## Instalação

Pré-requisitos: Python 3.10+ e PowerShell 5.1+.

Simule:

```powershell
.\scripts\bootstrap.ps1 -Mode Install -InstallCurator -WhatIf
```

Instale:

```powershell
.\scripts\bootstrap.ps1 -Mode Install -InstallCurator
```

Destinos padrão:

- agente: `%USERPROFILE%\.config\opencode\agents\cerebro-curador.md`
- script: `%USERPROFILE%\.agents\scripts\cerebro_curador.py`

Use `-CuratorAgentsDirectory` e `-CuratorScriptsDirectory` para outros destinos. A instalação:

- é opcional e nunca roda por padrão;
- compara o conteúdo antes de gravar; arquivo idêntico gera `CURATOR_OK` e nada é reescrito;
- arquivo divergente gera `CURATOR_CONFLICT`, preserva o conteúdo e interrompe a instalação;
- só substitui com `-Force` explícito;
- com `-WhatIf` apenas mostra `CURATOR_PLAN`;
- não altera a configuração global do OpenCode, o vault ou o `AGENTS.md`;
- grava UTF-8 sem BOM e resolve o caminho do script dentro do agente.

O bootstrap não mexe em `opencode.jsonc`. A conexão do plugin e do subagente continua manual.

## Vault explícito

O script não tem caminho de vault fixo. `--vault` é obrigatório em `previa`, `simulacao`, `confirmar` e `auditar`; `CEREBRO_VAULT` serve apenas como conveniência. Sem caminho válido, o script encerra com `ERRO` e nenhum fallback para diretório pessoal.

O subagente obtém o caminho da configuração efetiva do OpenCode: entrada de `plugins` cujo `package` aponta para o `open-mind-system`, campo `options.vaultPath`. Se não houver exatamente um vault configurado, ele para e apresenta o diagnóstico.

O estado do curador fica em `%LOCALAPPDATA%\cerebro-curador\` (`pendentes/`, `fila.jsonl`, `confirmacoes.jsonl`, `alteracoes.log`, `aprovados.jsonl`). O script recusa qualquer caminho de estado dentro do vault.

## Modos

| Modo | Efeito |
|---|---|
| `previa` | Analisa e grava a prévia fora do vault. Nada muda no vault. |
| `simulacao` | Mostra a prévia na tela, sem gravar arquivos. |
| `confirmar --lote <id> --itens <n>` | Grava somente os itens indicados, após revalidar. |
| `rejeitar --lote <id>` | Descarta a prévia. |
| `listar` | Lista prévias pendentes. |
| `auditar` | Lista notas do curador sem alteração há 30 dias. Não move nada. |

Limites preservados: 3 notas por sessão, validade de 24 horas, confirmação por lote e itens, detecção de duplicatas, bloqueio de conteúdo sensível e transcrição, atualização do índice da área e registro de alterações.

## Segurança

- **Hash SHA-256 de bytes.** O hash cobre os bytes originais do arquivo (LF/CRLF, BOM, ausência de newline final), em hexadecimal de 64 caracteres. O lote registra `hash_versao: 2`; lotes com o hash antigo de 16 caracteres são descartados sem execução e registrados no ledger como `lote-incompativel`.
- **Revalidação antes de cada gravação.** Cada item é revalidado imediatamente antes de escrever: validade do lote, item aprovado, destino permitido, hash atual, conflito de criação concorrente, duplicata e limite. Conflito interrompe a operação.
- **Falha parcial.** O lote é mantido com os itens já aplicados (`feitos`); repetir a confirmação retoma sem duplicar texto. A saída informa quantos itens foram gravados e se o lote não foi confirmado por inteiro.
- **Fins de linha.** Notas criadas usam LF. Atualizações e links de índice preservam o fim de linha do arquivo existente.
- **Dados sensíveis.** Credenciais, e-mails, telefones, CPF, cartão e transcrições do chat são descartados na prévia.

## Exceção de escrita direta

O curador **não** usa `open_mind_create` nem `open_mind_update`. A escrita é feita pelo Python, de forma controlada e com confirmação própria.

Consequência: essa gravação não passa por `ctx.permission.assert` do plugin e **não é bloqueada por `writePolicy: "disabled"`**. Desabilitar a escrita das ferramentas `open_mind_*` não desabilita o curador. Para impedir a gravação do curador, não instale o subagente ou não confirme os lotes.

Integrar essa escrita às ferramentas do plugin exigiria um protocolo de execução e reconciliação entre confirmação e chamadas, o que está fora do escopo desta fase.

## Divergências conhecidas em relação ao `AGENTS.md`

O `AGENTS.md` do vault continua sendo a fonte canônica das regras de organização. O script implementa um subconjunto:

- roteamento pelas áreas canônicas e destino mais específico;
- não cria projetos ou clientes inexistentes: destino incerto cai na fila;
- preserva índices e não os usa como destino de nota;
- não move notas para `arquivo/`.

Fora do script: as regras de reunião, glossário de nomenclatura de banco, criação de pessoa/empresa a partir de uma captura e prazos do diário. Isso fica com o agente principal e não bloqueia a curadoria.

## Testes

```powershell
npm run test:curator
```

Sem Python, o runner imprime `SKIP` e sai com código 0. Os 20 cenários usam diretórios temporários: prévia, simulação, confirmação, rejeição, listagem, expiração, limite, duplicata, concorrência antes e durante a gravação, retomada após falha parcial, LF/CRLF, caminho inválido, sensíveis, índice, idempotência, lote com hash antigo e vault explícito. Nenhum teste toca o vault pessoal ou a configuração global.

`npm run check` executa testes TypeScript, PowerShell, curador e typecheck.
