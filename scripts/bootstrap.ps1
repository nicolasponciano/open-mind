[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "Medium")]
param(
  [ValidateSet("Install", "Validate", "Restore", "Update")]
  [string]$Mode = "Validate",

  [string]$VaultPath,

  [switch]$InitializeVault
)

$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).ProviderPath
$setupScript = Join-Path $PSScriptRoot "setup-vault.ps1"

foreach ($requiredPath in @("package.json", "open-mind.ts", "src")) {
  if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot $requiredPath))) {
    throw "Repositorio Open Mind invalido ou incompleto; item ausente: $requiredPath"
  }
}
if (-not (Test-Path -LiteralPath $setupScript -PathType Leaf)) {
  throw "Script de estrutura ausente: scripts/setup-vault.ps1"
}

$nodeCommand = Get-Command "node" -ErrorAction SilentlyContinue
if ($nodeCommand) {
  $nodeVersionText = (& $nodeCommand.Source --version 2>$null | Out-String).Trim()
  Write-Output "NODE: $nodeVersionText"
  if ($nodeVersionText -match "^v(\d+)") {
    $nodeMajor = [int]$Matches[1]
    if ($nodeMajor -lt 24) { Write-Output "PREREQUISITE_WARNING: Node.js 24+ e recomendado para testes e desenvolvimento." }
  }
}
else {
  Write-Output "PREREQUISITE_MISSING: Node.js nao encontrado; o plugin nao podera ser validado neste ambiente."
}

if ($InitializeVault -and $Mode -ne "Install") {
  throw "-InitializeVault so pode ser usado com -Mode Install."
}
if ($InitializeVault -and -not $VaultPath) {
  throw "-InitializeVault exige -VaultPath absoluto para uma raiz existente."
}

if ($Mode -eq "Update") {
  Write-Output "UPDATE_PLAN: nenhuma migracao versionada esta definida; nenhum arquivo ou configuracao foi alterado."
  return
}

if (-not $VaultPath) {
  if ($Mode -eq "Restore") {
    Write-Output "DATA_NOT_RESTORED: Restore nao recupera dados; forneca um vault ja recuperado por uma fonte independente."
  }
  else {
    Write-Output "INFRASTRUCTURE_ONLY: repositorio validado; nenhum vault foi configurado ou criado."
  }
  if ($Mode -eq "Install") {
    Write-Output "CONFIG_PLAN: adicione manualmente o plugin deste repositorio ao OpenCode e informe o caminho de um vault existente; nenhuma configuracao global foi alterada."
  }
  return
}

if (-not [IO.Path]::IsPathRooted($VaultPath)) {
  throw "VaultPath deve ser absoluto. Nenhuma alteracao foi feita."
}
# IsPathRooted aceita caminhos relativos a drive (ex.: C:rel); eles dependem do diretorio atual.
if ($VaultPath -match '^[A-Za-z]:(?![\\/])') {
  throw "VaultPath deve ser totalmente qualificado; caminhos relativos a drive nao sao aceitos. Nenhuma alteracao foi feita."
}
if (-not (Test-Path -LiteralPath $VaultPath -PathType Container)) {
  if ($Mode -eq "Restore") {
    Write-Output "DATA_NOT_RESTORED: o caminho informado nao existe; restaure o vault por uma fonte independente e execute Restore novamente."
    return
  }
  throw "VaultPath deve apontar para um diretorio existente. O bootstrap nao cria a raiz do vault."
}

$resolvedVault = (Resolve-Path -LiteralPath $VaultPath).ProviderPath
if ($InitializeVault) {
  if ($WhatIfPreference) {
    $setupOutput = @(& $setupScript -VaultPath $resolvedVault -WhatIf)
  }
  else {
    $setupOutput = @(& $setupScript -VaultPath $resolvedVault)
  }
  foreach ($line in $setupOutput) { Write-Output $line }
  if (@($setupOutput | Where-Object { $_ -match "^DIAGNOSTIC:" }).Count -gt 0) {
    Write-Output "NON_CANONICAL: nenhuma pasta foi criada; revise a estrutura antes de qualquer migracao."
    return
  }
  if ($WhatIfPreference) {
    Write-Output "INSTALL_PLAN: estrutura simulada; nenhum diretorio foi criado."
  }
  else {
    Write-Output "INSTALL_READY: estrutura de diretorios concluida; AGENTS.md e arquivos de contexto nao foram criados nem alterados."
  }
  return
}

$structureReport = @(& $setupScript -VaultPath $resolvedVault -WhatIf)
foreach ($line in $structureReport) { Write-Output $line }
if (@($structureReport | Where-Object { $_ -match "^DIAGNOSTIC:" }).Count -gt 0) {
  Write-Output "NON_CANONICAL: vault diagnosticado; nenhuma estrutura paralela foi criada."
  return
}

$agentsStatus = if (Test-Path -LiteralPath (Join-Path $resolvedVault "AGENTS.md") -PathType Leaf) { "present" } else { "missing" }
$mapStatus = if (Test-Path -LiteralPath (Join-Path $resolvedVault "00 - Open Mind.md") -PathType Leaf) { "present" } else { "missing" }
Write-Output "VAULT_CHECK: AGENTS.md=$agentsStatus; 00 - Open Mind.md=$mapStatus; estrutura avaliada sem escrita."

if ($Mode -eq "Restore") {
  if ($agentsStatus -eq "present" -and $mapStatus -eq "present") {
    Write-Output "RECONNECT_READY: vault previamente existente validado; Restore nao recupera dados e a configuracao global do OpenCode nao foi alterada."
  }
  else {
    $missingBase = @()
    if ($agentsStatus -ne "present") { $missingBase += "AGENTS.md" }
    if ($mapStatus -ne "present") { $missingBase += "00 - Open Mind.md" }
    Write-Output ("RECONNECT_INCOMPLETE: arquivos-base ausentes (" + ($missingBase -join ", ") + "); Restore nao cria nem recupera arquivos. Restaure-os por uma fonte independente e execute Restore novamente.")
  }
}
elseif ($Mode -eq "Install") {
  Write-Output "INSTALL_READY: infraestrutura validada. Para criar pastas ausentes, execute novamente com -InitializeVault; nenhuma configuracao global foi alterada."
}
else {
  Write-Output "VALIDATION_COMPLETE: nenhuma alteracao foi feita."
}
