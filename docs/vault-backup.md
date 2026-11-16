# Backup e recuperacao do vault

Backup criptografado do vault do Segundo Cerebro com 7-Zip + Google Drive Desktop.
Destino: `G:\Meu Drive\open-mind-memory`.

## Como funciona

- Scripts: `scripts/backup-vault.ps1` e `scripts/restore-vault-backup.ps1`.
- Formato: `.7z` com AES-256 e nomes internos criptografados (`-mhe=on`).
- Senha: digitada no prompt do 7-Zip. Nao existe senha em script, argumento, variavel de ambiente, log ou arquivo.
- Cada backup inclui `sha256-manifest.txt` com o hash de cada arquivo, gerado antes da compactacao.
- `.tmp.driveupload` do vault fica fora do backup e nao e alterado no vault.
- Backups anteriores nunca sao sobrescritos nem apagados.

## Criar um backup

Em um terminal PowerShell (a senha e digitada nele, nao em scripts):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\open-mind-system\scripts\backup-vault.ps1
```

O script copia o vault para `%TEMP%`, gera o manifesto, compacta com senha, testa a integridade, confere a quantidade de arquivos e so entao move o `.7z` para `open-mind-memory`.
Saida esperada: `BACKUP_OK: arquivo=...; tamanho_bytes=...; arquivos=...`.

Durante o backup o 7-Zip pede a senha tres vezes (criacao, confirmacao, teste de integridade). Se a senha digitada no teste nao for a mesma da criacao, o backup e descartado e nada e publicado.

Compare a linha `Files:` do 7-Zip com o `arquivos_esperados` impresso pelo script. A conferencia automatica de conteudo e feita no restore.

Opcoes uteis:

| Parametro | Uso |
|---|---|
| `-WhatIf` | Mostra destino e nome do arquivo, sem criar nada e sem pedir senha. |
| `-VaultPath` | Outro vault (padrao `C:\Obsidian\open-mind`). |
| `-Destination` | Outra pasta de destino (padrao `G:\Meu Drive\open-mind-memory`). |
| `-KeepStaging` | Mantem o diretorio temporario para inspecao. |

## Verificar a integridade

```powershell
& "C:\Program Files\7-Zip\7z.exe" t "G:\Meu Drive\open-mind-memory\open-mind-backup-AAAA-MM-DD-HHMM.7z"
```

Deve terminar com `Everything is Ok`. Sem a senha, o 7-Zip nao lista nenhum nome interno.

## Confirmar o upload (obrigatorio)

Arquivo visivel na unidade `G:` nao e prova de upload. `G:` e um volume de streaming; a confirmacao e no Drive Web.

1. Abra `drive.google.com` e a pasta `open-mind-memory`.
2. Confirme que o arquivo aparece com a mesma data e o mesmo tamanho.
3. Baixe o arquivo pelo navegador (botao de download, nao copia pelo Explorer) e compare o SHA-256 com a origem:

```powershell
$g = "G:\Meu Drive\open-mind-memory\open-mind-backup-AAAA-MM-DD-HHMM.7z"
$d = "$env:USERPROFILE\Downloads\open-mind-backup-AAAA-MM-DD-HHMM.7z"
(Get-FileHash $g -Algorithm SHA256).Hash -eq (Get-FileHash $d -Algorithm SHA256).Hash
```

`True` significa upload concluido e download integro. Nesse ponto o backup existe fora do computador.

Sem esse passo, o backup real e o arquivo local, nao o remoto.

## Restaurar depois de formatar

1. Instale 7-Zip, Google Drive Desktop e o OpenCode.
2. Baixe o `.7z` desejado pelo navegador, em `drive.google.com`.
3. Restaure em um diretorio temporario, fora do vault e do repositorio:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\open-mind-system\scripts\restore-vault-backup.ps1 `
  -Archive "$env:USERPROFILE\Downloads\open-mind-backup-AAAA-MM-DD-HHMM.7z" `
  -TargetPath "$env:TEMP\open-mind-restore"
```

Um prompt de senha, na extracao. Saida esperada: `RESTORE_OK`, com `arquivos_ausentes=0`, `hashes_divergentes=0` e `arquivos_extras=0`.
O script nunca escreve no vault original. Se algo divergir, ele falha e nao remove nada.

4. Valide a estrutura:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\open-mind-system\scripts\bootstrap.ps1 -Mode Restore -VaultPath "$env:TEMP\open-mind-restore"
```

Esperado: `RECONNECT_READY` e `VAULT_CHECK: AGENTS.md=present; 00 - Open Mind.md=present`.

5. Mova a pasta restaurada para `C:\Obsidian\open-mind` e abra no Obsidian.

## Conferencia apos restaurar

O criterio de integridade e o manifesto dentro do arquivo (`sha256-manifest.txt`). Se comparar o restaurado com o vault ativo, `.obsidian/graph.json` e `.obsidian/workspace.json` podem divergir: o Obsidian reescreve esses dois arquivos de estado a cada abertura. Divergencia neles nao indica perda de dados.

## Limpeza

O restore mantem o diretorio restaurado por padrao, para inspecao. Use `-Cleanup` para remover depois de validar, ou apague a pasta manualmente.

## Limites conhecidos

- A senha e a unica chave. Sem ela o backup e irrecuperavel: guarde-a em gerenciador de senhas fora do computador.
- O Drive pode demorar para subir arquivos grandes; confirme sempre no Drive Web, com comparacao de SHA-256.
- Nada e agendado nem apagado automaticamente. Cada backup ocupa cerca de 34 KB.
- Nunca rode o script com a saida redirecionada (`*> log.txt`, `| Tee-Object`, `$x = & ...`). O 7-Zip escreve o prompt de senha em stdout; redirecionar esconde o prompt.
- Nao acrescente `-p` ao `t` ou ao `x`: sem valor, eles usam senha vazia, nao pedem nada e falham com `Wrong password?`. So o `a` usa `-p` avulso.

## Estado em 2026-11-15

Backup real validado de ponta a ponta: `open-mind-backup-2026-11-15-0410.7z` (34.304 bytes, 66 arquivos + manifesto), AES-256 com nomes criptografados, `Everything is Ok` no `7z t`, upload confirmado com download pelo navegador e SHA-256 identico, `RESTORE_OK` com 0 ausentes, 0 divergentes e 0 extras, `RECONNECT_READY` no bootstrap.
