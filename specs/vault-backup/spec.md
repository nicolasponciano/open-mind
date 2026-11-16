# Backup criptografado do vault

## Problema

O vault `C:\Obsidian\open-mind` e a fonte unica do Segundo Cerebro e nao tem backup verificavel. Uma formatacao do computador perde notas, indices e anexos. Google Drive Desktop e 7-Zip ja estao instalados, entao o custo de resolver isso e baixo.

## Escopo

- RF-01 Backup completo do vault: notas, indices, anexos, `AGENTS.md`, `00 - Open Mind.md`, `.obsidian/`, `docs/` e `setup-vault.ps1`.
- RF-02 Compactacao com 7-Zip em AES-256 e nomes internos criptografados.
- RF-03 Nome datado com hora, sem sobrescrever backups anteriores.
- RF-04 Destino `G:\Meu Drive\open-mind-memory`.
- RF-05 Verificacao de integridade do arquivo `.7z`.
- RF-06 Confirmacao de upload pelo Google Drive (download real via web).
- RF-07 Teste de restauracao em diretorio temporario com comparacao de SHA-256.
- RF-08 Validacao da estrutura restaurada pelo `scripts/bootstrap.ps1 -Mode Restore`.
- RF-09 Procedimento de recuperacao pos-formatacao documentado.

## Fora de escopo

- Alteracoes no Open Mind Core, Bridge, Adapter, `cerebro-curador` ou `AGENTS.md`.
- Novas tools, subagentes, MCPs, APIs ou banco de dados.
- Sincronizar o vault ativo com o Drive ou versionar conteudo do vault.
- Backup dos arquivos do repositorio.
- Exclusao automatica, rotacao ou retencao de backups.
- Agendamento, servico em segundo plano ou automacao completa nesta versao.
- Cofre de senhas integrado ao processo.

## Criterios de aceite

Todos comprovados em 2026-11-15 com o backup real `open-mind-backup-2026-11-15-0410.7z` (34.304 bytes, 66 arquivos + manifesto).

- [x] CA-01 (RF-01, RF-03) o backup inclui todos os arquivos do vault: a linha `Files:` do teste de integridade e igual a `arquivos_esperados` impresso pelo script, e a restauracao reproduz exatamente os arquivos do manifesto. Dois backups no mesmo dia geram arquivos distintos.
- [x] CA-02 (RF-02) `7z l` sem senha nao revela nenhum nome de arquivo interno.
- [x] CA-03 (RF-04, RF-06) o arquivo aparece em `drive.google.com` na pasta `open-mind-memory` e o download feito pelo navegador tem o mesmo SHA-256 do arquivo local (`56f3d862...b4769`).
- [x] CA-04 (RF-05) `7z t` no arquivo termina com `Everything is Ok`.
- [x] CA-05 (RF-07) a restauracao em `%TEMP%` reproduz todos os arquivos com SHA-256 identico ao manifesto gerado no momento do backup (zero divergencias).
- [x] CA-06 (RF-08) `bootstrap.ps1 -Mode Restore -VaultPath <temp>` imprime `RECONNECT_READY`.
- [x] CA-07 o vault original tem o mesmo hash agregado antes e depois do backup (nada foi modificado).
- [x] CA-08 (`git status`) nenhum `.7z`, manifesto, arquivo temporario ou conteudo do vault aparece no repositorio.

Observacao sobre CA-05: a conferencia valida e a do manifesto dentro do arquivo (0 ausentes, 0 divergentes, 0 extras). A comparacao posterior contra o vault ativo pode divergir em `.obsidian/graph.json` e `.obsidian/workspace.json`, que o Obsidian reescreve a cada abertura; isso nao indica perda de dados.

## Impacto no que ja existe

Somente arquivos novos: `specs/vault-backup/spec.md`, `scripts/backup-vault.ps1`, `scripts/restore-vault-backup.ps1` e `docs/vault-backup.md`. Nenhum codigo existente e chamado ou alterado, sem risco de regressao.

## Decisoes tecnicas

- Stack: Windows PowerShell 5.1 + 7-Zip 24.09 (`C:\Program Files\7-Zip\7z.exe`) + Google Drive Desktop (volume `G:` em streaming).
- Senha: digitada no prompt nativo do 7z. Nenhum `-p<senha>` na linha de comando, nenhum segredo em script, log ou arquivo. Alternativa rejeitada: `Read-Host` e repassar a senha como argumento, que a expoe na tabela de processos.
- 7z: `-t7z -m0=lzma2 -mx=9 -mhe=on` (headers e nomes criptografados).
- Manifesto `sha256-manifest.txt` (caminho relativo + SHA-256) gerado antes de compactar, incluido dentro do `.7z`, usado na comparacao pos-restauracao.
- Staging e extract em `%TEMP%`, fora do repositorio, removidos em `finally`.
- Exclusao: `.tmp.driveupload` (artefato transitorio do Drive).
- Scripts com `-WhatIf`, validacao de destino e falha explicita se o destino nao existir. Sem exclusao automatica.
- Execucao exige console interativo: o 7z le a senha do console e nao de stdin redirecionado (testado). Execucao sem console falha, o que impede senha em pipeline.
- `-p` sem valor e obrigatorio: sem ele o 7-Zip cria o arquivo SEM criptografia. Com ele, o 7z exibe o prompt em stdout.
- Causa-raiz comprovada (fixture, 7-Zip 24.09): `-p` avulso em `t` ou `x` (ex.: `7z t -p <arquivo>`) NAO pede senha; usa senha vazia e falha com `Cannot open encrypted archive. Wrong password?`. Sem `-p`, `t` e `x` pedem a senha corretamente. Em `a`, `-p` avulso pede a senha (criacao com confirmacao).
- Correção: `t` e `x` sem `-p`. A criacao mantem `-p` avulso.
- Sem `-p` no `a`, o arquivo sai SEM criptografia; por isso ele fica.
- Capturar a saida das chamadas 7z (`$x = & 7z ...`) nao e a causa comprovada deste bug, mas continua proibido por seguranca (esconde o prompt).
- Por isso a conferencia automatica de quantidade ocorre no restore (comparacao com o manifesto), e o backup apenas exibe `arquivos_esperados` e a linha `Files:` do proprio 7z.
- Nome do arquivo: `open-mind-backup-YYYY-MM-DD-HHmm.7z`, com sufixo `-2`, `-3` se o nome ja existir no destino.
- O restore mantem o diretorio temporario para inspecao; `-Cleanup` remove ao final.

## Decisoes em aberto

- Frequencia do backup (recomendacao: manual, mensal e antes de formatacao; automacao so na Etapa 3).
- Senha guardada em gerenciador de senhas fora do computador (recomendacao: obrigatorio, sem ela o arquivo e irrecuperavel).

## Tarefas

- [x] T-01 `scripts/backup-vault.ps1`: valida vault/destino, gera manifesto, compacta com prompt de senha, testa integridade e move para `open-mind-memory` (RF-01, RF-02, RF-04, RF-05).
- [x] T-02 `scripts/restore-vault-backup.ps1`: extrai em `%TEMP%`, compara com o manifesto, limpa e nao toca no vault (RF-07).
- [x] T-03 Primeiro backup real com dados do vault (fecha CA-01, CA-02, CA-04).
- [x] T-04 Confirmacao de upload via download pelo navegador e comparacao de SHA-256 (fecha CA-03).
- [x] T-05 Restauracao real + `bootstrap.ps1 -Mode Restore` (fecha CA-05, CA-06).
- [x] T-06 `docs/vault-backup.md` com criar, verificar e recuperar apos formatacao (RF-09).
- [x] T-07 Polimento: testes dos scripts em diretorio temporario e revisao de `git status` (fecha CA-08).
