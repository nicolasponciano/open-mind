[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "Medium")]
param(
  [Parameter(Mandatory = $true)][string]$Archive,
  [string]$TargetPath,
  [string]$SevenZipPath = "C:\Program Files\7-Zip\7z.exe",
  [string]$RepoRoot,
  [string]$VaultPath = "C:\Obsidian\open-mind",
  [switch]$Cleanup
)

# Restaura um backup criptografado em diretorio temporario e confere o manifesto SHA-256.
# A senha e digitada no prompt do proprio 7z. Nunca escreve no vault original.

$ErrorActionPreference = "Stop"

if (-not $RepoRoot) {
  $RepoRoot = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { (Get-Location).ProviderPath }
}

function Write-Step([string]$Message) { Write-Output "STEP: $Message" }

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
if (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) {
  throw "Arquivo de backup nao encontrado: $Archive"
}
$archiveFull = [IO.Path]::GetFullPath($Archive)
if ([IO.Path]::GetExtension($archiveFull) -ne ".7z") {
  throw "O arquivo informado nao e .7z: $archiveFull"
}

$repo = [IO.Path]::GetFullPath($RepoRoot).TrimEnd('\')
$vault = [IO.Path]::GetFullPath($VaultPath).TrimEnd('\')

if (-not $TargetPath) {
  $TargetPath = Join-Path $env:TEMP ("open-mind-restore-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
}
$target = [IO.Path]::GetFullPath($TargetPath).TrimEnd('\')

if (-not [IO.Path]::IsPathRooted($TargetPath) -or $TargetPath -match '^[A-Za-z]:(?![\\/])') {
  throw "TargetPath deve ser um caminho absoluto. Nenhuma alteracao foi feita."
}
if ($target.ToLowerInvariant() -eq $vault.ToLowerInvariant() -or (Test-PathInside $vault $target)) {
  throw "Restauracao sobre o vault nao e permitida. Nenhuma alteracao foi feita."
}
if ((Test-PathInside $target $repo) -or (Test-PathInside $target $vault)) {
  throw "TargetPath nao pode ficar dentro do repositorio nem conter o vault. Nenhuma alteracao foi feita."
}
if (Test-Path -LiteralPath $target) {
  $existing = @(Get-ChildItem -LiteralPath $target -Force)
  if ($existing.Count -gt 0) {
    throw "Diretorio de destino ja existe e nao esta vazio: $target. Nenhuma alteracao foi feita."
  }
}

if (-not $PSCmdlet.ShouldProcess($target, "Extrair backup para diretorio temporario")) {
  Write-Output "WHATIF: nada seria extraido."
  return
}

if (-not (Test-Path -LiteralPath $target)) {
  New-Item -ItemType Directory -Path $target -Force | Out-Null
}

Write-Step "arquivo=$archiveFull"
Write-Step "destino=$target"
Write-Output "PASSWORD_PROMPT: informe a senha do backup no prompt do 7-Zip."

& $SevenZipPath x -y "-o$target" $archiveFull
if ($LASTEXITCODE -ne 0) {
  throw "Falha ao extrair o arquivo (codigo $LASTEXITCODE)."
}

$manifestPath = Join-Path $target "sha256-manifest.txt"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "Manifesto SHA-256 nao encontrado dentro do backup."
}

$expected = @{}
foreach ($line in Get-Content -LiteralPath $manifestPath -Encoding UTF8) {
  if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#")) { continue }
  if ($line -match '^([0-9a-fA-F]{64})\s\s(.+)$') {
    $expected[$matches[2]] = $matches[1].ToLowerInvariant()
  }
  else {
    throw "Linha invalida no manifesto: entrada corrompida."
  }
}
if ($expected.Count -eq 0) {
  throw "Manifesto SHA-256 vazio ou invalido."
}
Write-Step "manifesto_arquivos=$($expected.Count)"

$mismatches = 0
$missing = 0
$verified = 0
foreach ($rel in ($expected.Keys | Sort-Object)) {
  $filePath = Join-Path $target ($rel -replace '/', '\')
  if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
    $missing++
    Write-Output "MISSING: $rel"
    continue
  }
  $actual = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected[$rel]) {
    $mismatches++
    Write-Output "HASH_MISMATCH: $rel"
  }
  else {
    $verified++
  }
}

$restoredFiles = @(Get-ChildItem -LiteralPath $target -Recurse -File -Force | Where-Object { $_.FullName -ne $manifestPath })
$extra = 0
foreach ($file in $restoredFiles) {
  $rel = Get-RelativePath $target $file.FullName
  if (-not $expected.ContainsKey($rel)) { $extra++ }
}

$requiredFiles = @("AGENTS.md", "00 - Open Mind.md")
$requiredMissing = @()
foreach ($name in $requiredFiles) {
  if (-not (Test-Path -LiteralPath (Join-Path $target $name) -PathType Leaf)) { $requiredMissing += $name }
}
if (-not (Test-Path -LiteralPath (Join-Path $target ".obsidian") -PathType Container)) { $requiredMissing += ".obsidian/" }

Write-Step "arquivos_verificados=$verified"
Write-Step "arquivos_ausentes=$missing"
Write-Step "hashes_divergentes=$mismatches"
Write-Step "arquivos_extras=$extra"

if ($verified -ne $expected.Count -or $mismatches -gt 0 -or $missing -gt 0 -or $requiredMissing.Count -gt 0) {
  Write-Output "RESTORE_FAILED: destino=$target; ausentes=$missing; divergentes=$mismatches; base_ausente=$($requiredMissing -join ', ')"
  Write-Output "PROXIMO_PASSO: revisar o destino acima. Nada foi removido."
  throw "Restauracao nao validada."
}

Write-Output "RESTORE_OK: destino=$target; arquivos=$verified; extras=$extra"
$bootstrap = Join-Path $repo "scripts\bootstrap.ps1"
Write-Output "VALIDAR_ESTRUTURA: powershell -NoProfile -ExecutionPolicy Bypass -File `"$bootstrap`" -Mode Restore -VaultPath `"$target`""

if ($Cleanup) {
  if ($PSCmdlet.ShouldProcess($target, "Remover diretorio temporario restaurado")) {
    Remove-Item -LiteralPath $target -Recurse -Force
    Write-Output "CLEANUP_OK: $target removido."
  }
}
else {
  Write-Output "MANTER_TEMPORARIO: $target (remova manualmente ou reexecute com -Cleanup)."
}
