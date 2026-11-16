[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "Medium")]
param(
  [string]$VaultPath = "C:\Obsidian\open-mind",
  [string]$Destination = "G:\Meu Drive\open-mind-memory",
  [string]$SevenZipPath = "C:\Program Files\7-Zip\7z.exe",
  [string]$RepoRoot,
  [string[]]$ExcludeTopLevel = @(".tmp.driveupload"),
  [switch]$KeepStaging
)

# Cria backup criptografado do vault com 7-Zip.
# A senha e digitada no prompt do proprio 7z: nao existe senha em script,
# argumento de processo, variavel de ambiente, log ou arquivo.

$ErrorActionPreference = "Stop"

if (-not $RepoRoot) {
  $RepoRoot = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { (Get-Location).ProviderPath }
}

function Write-Step([string]$Message) { Write-Output "STEP: $Message" }

function Assert-Directory([string]$Path, [string]$Label) {
  if (-not [IO.Path]::IsPathRooted($Path)) {
    throw "$Label deve ser um caminho absoluto. Nenhuma alteracao foi feita."
  }
  if ($Path -match '^[A-Za-z]:(?![\\/])') {
    throw "$Label deve ser totalmente qualificado. Nenhuma alteracao foi feita."
  }
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  if (-not (Test-Path -LiteralPath $full -PathType Container)) {
    throw "$Label nao existe: $full. Nenhuma alteracao foi feita."
  }
  return $full
}

function Test-PathInside([string]$Candidate, [string]$Root) {
  $c = ([IO.Path]::GetFullPath($Candidate).TrimEnd('\') + '\').ToLowerInvariant()
  $r = ([IO.Path]::GetFullPath($Root).TrimEnd('\') + '\').ToLowerInvariant()
  return $c.StartsWith($r)
}

function Get-RelativePath([string]$Root, [string]$FullPath) {
  $rootFull = ([IO.Path]::GetFullPath($Root).TrimEnd('\') + '\')
  $full = [IO.Path]::GetFullPath($FullPath)
  return $full.Substring($rootFull.Length).Replace('\', '/')
}

if (-not (Test-Path -LiteralPath $SevenZipPath -PathType Leaf)) {
  throw "7-Zip nao encontrado em $SevenZipPath. Ajuste -SevenZipPath."
}

$vault = Assert-Directory $VaultPath "VaultPath"
$destination = Assert-Directory $Destination "Destination"
$repo = [IO.Path]::GetFullPath($RepoRoot).TrimEnd('\')

if ((Test-PathInside $vault $repo) -or $vault.ToLowerInvariant() -eq $repo.ToLowerInvariant()) {
  throw "O vault nao pode estar dentro do repositorio. Nenhuma alteracao foi feita."
}
if ((Test-PathInside $destination $repo) -or (Test-PathInside $repo $destination)) {
  throw "O destino nao pode estar dentro do repositorio (nem conter o repositorio). Nenhuma alteracao foi feita."
}
if ((Test-PathInside $destination $vault) -or (Test-PathInside $vault $destination)) {
  throw "Destino e vault nao podem estar aninhados. Nenhuma alteracao foi feita."
}

$stamp = Get-Date -Format "yyyy-MM-dd-HHmm"
$baseName = "open-mind-backup-$stamp"
$archiveName = "$baseName.7z"
$suffix = 1
while (Test-Path -LiteralPath (Join-Path $destination $archiveName)) {
  $suffix++
  $archiveName = "$baseName-$suffix.7z"
  if ($suffix -gt 99) {
    throw "Nao foi possivel gerar um nome de arquivo unico. Nenhuma alteracao foi feita."
  }
}

if (-not $PSCmdlet.ShouldProcess($archiveName, "Criar backup criptografado em $destination")) {
  Write-Output "WHATIF: nenhum arquivo criado; nenhuma senha solicitada."
  Write-Output "WHATIF: destino=$destination; arquivo=$archiveName"
  return
}

$staging = Join-Path $env:TEMP ("open-mind-backup-" + (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$stagingVault = Join-Path $staging "vault"
$createdArchive = $null

try {
  Write-Step "vault=$vault"
  Write-Step "destino=$destination"
  Write-Step "staging=$staging"

  New-Item -ItemType Directory -Path $stagingVault -Force | Out-Null

  $copied = 0
  foreach ($item in (Get-ChildItem -LiteralPath $vault -Force)) {
    if ($ExcludeTopLevel -contains $item.Name) {
      Write-Step "excluido=$($item.Name)"
      continue
    }
    Copy-Item -LiteralPath $item.FullName -Destination $stagingVault -Recurse -Force
    $copied++
  }
  Write-Step "top_level_copiado=$copied"

  $files = @(Get-ChildItem -LiteralPath $stagingVault -Recurse -File -Force | Sort-Object FullName)
  if ($files.Count -eq 0) {
    throw "Nenhum arquivo encontrado para backup. Nenhuma alteracao foi feita."
  }

  $manifestPath = Join-Path $stagingVault "sha256-manifest.txt"
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add("# open-mind-backup manifest")
  $lines.Add("# gerado_utc=" + (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ"))
  $lines.Add("# arquivos=$($files.Count)")
  foreach ($file in $files) {
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $rel = Get-RelativePath $stagingVault $file.FullName
    $lines.Add("$hash  $rel")
  }
  Set-Content -LiteralPath $manifestPath -Value $lines -Encoding UTF8
  Write-Step "manifesto_arquivos=$($files.Count)"

  $expectedEntries = $files.Count + 1  # manifesto incluido no arquivo

  $archivePath = Join-Path $staging $archiveName
  Write-Step "arquivo=$archiveName"
  Write-Step "arquivos_esperados=$expectedEntries"
  Write-Output "PASSWORD_PROMPT: informe a senha no prompt do 7-Zip (o 7-Zip pede confirmacao na criacao e a senha de novo no teste de integridade)."

  # Criacao: "-p" sem valor faz o 7-Zip pedir a senha (2 vezes). Sem -p o arquivo sai SEM criptografia.
  # Teste/extracao: NAO usar "-p" avulso. Com "t -p <arquivo>" o 7-Zip usa senha vazia sem pedir
  # e falha com "Wrong password?". Sem -p, o 7-Zip pede a senha corretamente.
  # Nunca capture a saida destas chamadas (ex.: $x = & 7z ...) nem redirecione stdout.
  $createArgs = @("a", "-t7z", "-m0=lzma2", "-mx=9", "-mhe=on", "-bd", "-y", "-p", $archivePath, (Join-Path $stagingVault "*"))
  & $SevenZipPath @createArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Falha ao criar o arquivo (codigo $LASTEXITCODE). Nenhum backup foi publicado."
  }
  if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
    throw "Arquivo nao foi criado. Nenhum backup foi publicado."
  }
  $createdArchive = $archivePath

  Write-Step "testando_integridade"
  & $SevenZipPath t $archivePath
  if ($LASTEXITCODE -ne 0) {
    throw "Teste de integridade falhou (codigo $LASTEXITCODE). O arquivo nao sera publicado."
  }
  Write-Step "integridade_ok"
  Write-Output "CONFERIR: a linha 'Files:' acima deve mostrar $expectedEntries. A conferencia automatica de conteudo ocorre no restore."

  $finalPath = Join-Path $destination $archiveName
  if (Test-Path -LiteralPath $finalPath) {
    throw "Ja existe um arquivo com esse nome no destino. Nada foi sobrescrito."
  }

  Move-Item -LiteralPath $archivePath -Destination $finalPath
  $createdArchive = $null

  $size = (Get-Item -LiteralPath $finalPath).Length
  Write-Output "BACKUP_OK: arquivo=$finalPath; tamanho_bytes=$size; arquivos=$($files.Count)"
  Write-Output "PENDENTE: confirme o upload em drive.google.com antes de considerar o backup remoto concluido."
}
finally {
  if ($createdArchive -and (Test-Path -LiteralPath $createdArchive)) {
    Remove-Item -LiteralPath $createdArchive -Force -ErrorAction SilentlyContinue
  }
  if (-not $KeepStaging -and (Test-Path -LiteralPath $staging)) {
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
  }
  elseif ($KeepStaging) {
    Write-Output "STAGING_KEPT: $staging"
  }
}
