[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "Medium")]
param(
  [ValidateSet("Install", "Validate", "Restore", "Update")]
  [string]$Mode = "Validate",

  [string]$VaultPath,

  [switch]$InitializeVault,

  # Instalação opcional do curador (agente + script) fora do repositório.
  [switch]$InstallCurator,

  [string]$CuratorAgentsDirectory = (Join-Path $HOME ".config\opencode\agents"),

  [string]$CuratorScriptsDirectory = (Join-Path $HOME ".agents\scripts"),

  # Sobrescreve arquivo global diferente do repositório. Sem -Force, nada é alterado.
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).ProviderPath
$setupScript = Join-Path $PSScriptRoot "setup-vault.ps1"

function Install-CuratorFiles {
  [CmdletBinding(SupportsShouldProcess = $true)]
  param(
    [Parameter(Mandatory = $true)][string]$AgentsDirectory,
    [Parameter(Mandatory = $true)][string]$ScriptsDirectory,
    [switch]$ForceOverwrite
  )

  $scriptDestino = Join-Path $ScriptsDirectory "cerebro_curador.py"
  $arquivos = @(
    [pscustomobject]@{ Origem = "agents\cerebro-curador.md"; Destino = (Join-Path $AgentsDirectory "cerebro-curador.md"); Tipo = "agente" },
    [pscustomobject]@{ Origem = "scripts\curador_roteamento.py"; Destino = (Join-Path $ScriptsDirectory "curador_roteamento.py"); Tipo = "script" },
    [pscustomobject]@{ Origem = "scripts\curador_revisao.py"; Destino = (Join-Path $ScriptsDirectory "curador_revisao.py"); Tipo = "script" },
    [pscustomobject]@{ Origem = "scripts\cerebro_curador.py"; Destino = $scriptDestino; Tipo = "script" }
  )
  $conflitos = 0
  foreach ($arquivo in $arquivos) {
    $origem = Join-Path $repositoryRoot $arquivo.Origem
    if (-not (Test-Path -LiteralPath $origem -PathType Leaf)) {
      throw "Arquivo do curador ausente no repositorio: $($arquivo.Origem)"
    }
    $conteudo = (Get-Content -LiteralPath $origem -Raw -Encoding UTF8) -replace "`r`n", "`n"
    if ($arquivo.Tipo -eq "agente") {
      $conteudo = $conteudo.Replace("__CURATOR_SCRIPT__", $scriptDestino)
    }

    $existente = $null
    if (Test-Path -LiteralPath $arquivo.Destino -PathType Leaf) {
      $existente = (Get-Content -LiteralPath $arquivo.Destino -Raw -Encoding UTF8) -replace "`r`n", "`n"
      if ($existente -eq $conteudo) {
        Write-Output "CURATOR_OK: $($arquivo.Destino) ja corresponde ao repositorio"
        continue
      }
    }

    if (-not $PSCmdlet.ShouldProcess($arquivo.Destino, "instalar $($arquivo.Tipo) do curador")) {
      Write-Output "CURATOR_PLAN: $($arquivo.Destino)"
      continue
    }

    if ($null -ne $existente -and -not $ForceOverwrite) {
      $diferencas = @(Compare-Object -ReferenceObject ($existente -split "`n") -DifferenceObject ($conteudo -split "`n"))
      Write-Output "CURATOR_CONFLICT: $($arquivo.Destino) difere do repositorio em $($diferencas.Count) linha(s); nada foi sobrescrito. Revise e use -Force para substituir."
      $conflitos++
      continue
    }

    $pastaDestino = Split-Path -Parent $arquivo.Destino
    if (-not (Test-Path -LiteralPath $pastaDestino -PathType Container)) {
      New-Item -ItemType Directory -Path $pastaDestino -Force | Out-Null
    }
    [IO.File]::WriteAllText($arquivo.Destino, $conteudo, (New-Object System.Text.UTF8Encoding($false)))
    $acao = if ($null -eq $existente) { "instalado" } else { "atualizado" }
    Write-Output "CURATOR_UPDATED: $($arquivo.Destino) ($acao)"
  }

  if ($conflitos -gt 0) {
    throw "CURATOR_INCOMPLETE: $conflitos arquivo(s) preservado(s) por diferenca. Nenhuma sobrescrita silenciosa."
  }
  Write-Output "CURATOR_READY: agente e script do curador disponiveis; a configuracao global do OpenCode nao foi alterada."
}


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

if ($InstallCurator -and $Mode -ne "Install") {
  throw "-InstallCurator so pode ser usado com -Mode Install."
}

if ($InstallCurator) {
  if (-not $CuratorAgentsDirectory -or -not $CuratorScriptsDirectory) {
    throw "-InstallCurator exige diretorios de destino para agente e script."
  }
  Install-CuratorFiles -AgentsDirectory $CuratorAgentsDirectory `
    -ScriptsDirectory $CuratorScriptsDirectory -ForceOverwrite:$Force.IsPresent
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
