$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$bootstrap = Join-Path $repositoryRoot "scripts\bootstrap.ps1"
$setup = Join-Path $repositoryRoot "scripts\setup-vault.ps1"
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("open-mind-bootstrap-tests-" + [guid]::NewGuid().ToString("N"))

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}

# Executa o script e devolve stdout/stderr. Erros terminais propagam e falham o teste:
# nenhum codigo de saida nativo e usado aqui, porque scripts PowerShell nao definem $LASTEXITCODE.
function Invoke-Script([string]$Path, [hashtable]$Arguments) {
  $output = & $Path @Arguments 2>&1
  return ($output | Out-String)
}

function Invoke-ScriptExpectFailure([string]$Path, [hashtable]$Arguments) {
  $failed = $false
  $output = ""
  try {
    $output = (& $Path @Arguments 2>&1 | Out-String)
  }
  catch {
    $failed = $true
    $output = $_.Exception.Message
  }
  return [pscustomobject]@{ Failed = $failed; Output = $output }
}

try {
  New-Item -ItemType Directory -Path $tempRoot | Out-Null

  Assert-True (Test-Path -LiteralPath $setup -PathType Leaf) "scripts/setup-vault.ps1 deve existir"
  Assert-True (Test-Path -LiteralPath $bootstrap -PathType Leaf) "scripts/bootstrap.ps1 deve existir"

  $vault = Join-Path $tempRoot "vault"
  New-Item -ItemType Directory -Path $vault | Out-Null
  $constitution = Join-Path $vault "AGENTS.md"
  Set-Content -LiteralPath $constitution -Value "# Personalizado" -NoNewline
  $originalAgentsHash = (Get-FileHash -LiteralPath $constitution -Algorithm SHA256).Hash

  $whatIf = Invoke-Script -Path $setup -Arguments @{ VaultPath = $vault; WhatIf = $true }
  Assert-True ($whatIf -match "PLANNED: inbox") "-WhatIf deve descrever ações"
  Assert-True (-not (Test-Path (Join-Path $vault "inbox"))) "-WhatIf não deve criar pastas"

  Invoke-Script -Path $setup -Arguments @{ VaultPath = $vault } | Out-Null
  $canonical = @("inbox", "diario", "pessoas", "empresas", "clientes", "reunioes", "deals", "financas", "projetos", "conteudo", "conhecimento", "pessoal", "referencias", "arquivo")
  foreach ($folder in $canonical) {
    Assert-True (Test-Path -LiteralPath (Join-Path $vault $folder) -PathType Container) "pasta canônica ausente: $folder"
  }
  foreach ($folder in @("conteudo\ideias", "conhecimento\raw", "conhecimento\wiki")) {
    Assert-True (Test-Path -LiteralPath (Join-Path $vault $folder) -PathType Container) "subpasta canônica ausente: $folder"
  }
  Assert-True ((Get-FileHash -LiteralPath $constitution -Algorithm SHA256).Hash -eq $originalAgentsHash) "AGENTS.md personalizado foi alterado"

  $freshVault = Join-Path $tempRoot "fresh-vault"
  New-Item -ItemType Directory -Path $freshVault | Out-Null
  Invoke-Script -Path $setup -Arguments @{ VaultPath = $freshVault } | Out-Null
  Assert-True (-not (Test-Path (Join-Path $freshVault "AGENTS.md"))) "setup gerou AGENTS.md automaticamente"

  $before = @(Get-ChildItem -LiteralPath $vault -Directory -Recurse | ForEach-Object { $_.FullName.Substring($vault.Length) } | Sort-Object)
  Invoke-Script -Path $setup -Arguments @{ VaultPath = $vault } | Out-Null
  $after = @(Get-ChildItem -LiteralPath $vault -Directory -Recurse | ForEach-Object { $_.FullName.Substring($vault.Length) } | Sort-Object)
  Assert-True (($before -join "|") -eq ($after -join "|")) "segunda execução mudou a estrutura"

  $nonCanonical = Join-Path $tempRoot "noncanonical"
  New-Item -ItemType Directory -Path (Join-Path $nonCanonical "notas") -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $nonCanonical "notas\legado.md") -Value "preservar"
  $diagnostic = Invoke-Script -Path $setup -Arguments @{ VaultPath = $nonCanonical }
  Assert-True ($diagnostic -match "não canônica|nao canonica|non-canonical") "estrutura não canônica não foi diagnosticada"
  Assert-True (-not (Test-Path (Join-Path $nonCanonical "inbox"))) "estrutura paralela foi criada"
  Assert-True (Test-Path (Join-Path $nonCanonical "notas\legado.md")) "arquivo legado foi alterado"

  $mixedVault = Join-Path $tempRoot "mixed-vault"
  New-Item -ItemType Directory -Path (Join-Path $mixedVault "diario"), (Join-Path $mixedVault "notas") -Force | Out-Null
  $mixedDiagnostic = Invoke-Script -Path $setup -Arguments @{ VaultPath = $mixedVault }
  Assert-True ($mixedDiagnostic -match "nao canonica") "estrutura mista não foi diagnosticada"
  Assert-True (-not (Test-Path (Join-Path $mixedVault "inbox"))) "setup criou estrutura paralela em vault misto"

  $outside = Join-Path $tempRoot "outside"
  $linkedVault = Join-Path $tempRoot "linked-vault"
  New-Item -ItemType Directory -Path $outside, $linkedVault | Out-Null
  $linkCreated = $false
  try {
    New-Item -ItemType Junction -Path (Join-Path $linkedVault "conteudo") -Target $outside | Out-Null
    $linkCreated = $true
  }
  catch {
    Write-Output "SKIP: teste de junction indisponivel neste ambiente"
  }
  if ($linkCreated) {
    $junctionResult = Invoke-ScriptExpectFailure -Path $setup -Arguments @{ VaultPath = $linkedVault }
    Assert-True $junctionResult.Failed "setup seguiu um link de diretorio fora do vault"
    Assert-True (-not (Test-Path (Join-Path $outside "ideias"))) "setup escreveu fora do vault"
  }

  $partialVault = Join-Path $tempRoot "partial-vault"
  New-Item -ItemType Directory -Path $partialVault | Out-Null
  Set-Content -LiteralPath (Join-Path $partialVault "diario") -Value "preservar arquivo"
  $partialResult = Invoke-ScriptExpectFailure -Path $setup -Arguments @{ VaultPath = $partialVault }
  Assert-True $partialResult.Failed "setup não reportou erro de estrutura parcial inválida"
  Assert-True (Test-Path (Join-Path $partialVault "diario") -PathType Leaf) "falha parcial removeu dado existente"
  Assert-True (Test-Path (Join-Path $partialVault "inbox") -PathType Container) "falha parcial removeu alteração anterior ou não preservou estado"

  # --- Validação de caminhos ---
  $relativeResult = Invoke-ScriptExpectFailure -Path $setup -Arguments @{ VaultPath = "relative-vault" }
  Assert-True $relativeResult.Failed "setup aceitou caminho relativo"

  $driveRelativeResult = Invoke-ScriptExpectFailure -Path $setup -Arguments @{ VaultPath = "C:rel" }
  Assert-True $driveRelativeResult.Failed "setup aceitou caminho drive-relativo"
  Assert-True ($driveRelativeResult.Output -match "totalmente qualificado") "setup rejeitou drive-relativo sem mensagem específica"

  $driveRelativeBootstrap = Invoke-ScriptExpectFailure -Path $bootstrap -Arguments @{ Mode = "Restore"; VaultPath = "C:rel" }
  Assert-True $driveRelativeBootstrap.Failed "bootstrap aceitou caminho drive-relativo"

  $filesystemRootResult = Invoke-ScriptExpectFailure -Path $setup -Arguments @{ VaultPath = ([IO.Path]::GetPathRoot($env:SystemDrive + "\")) }
  Assert-True $filesystemRootResult.Failed "setup aceitou a raiz do filesystem"

  $fileAsVault = Join-Path $tempRoot "arquivo-vault.txt"
  Set-Content -LiteralPath $fileAsVault -Value "nao e diretorio"
  $fileAsVaultResult = Invoke-ScriptExpectFailure -Path $setup -Arguments @{ VaultPath = $fileAsVault }
  Assert-True $fileAsVaultResult.Failed "setup aceitou um arquivo como vault"
  Assert-True (Test-Path -LiteralPath $fileAsVault -PathType Leaf) "setup alterou o arquivo usado como vault inválido"

  # --- Restore ---
  $noVault = Invoke-Script -Path $bootstrap -Arguments @{ Mode = "Validate" }
  Assert-True ($noVault -match "INFRASTRUCTURE_ONLY") "bootstrap sem vault deve validar apenas infraestrutura"

  $missingRestore = Invoke-Script -Path $bootstrap -Arguments @{ Mode = "Restore"; VaultPath = (Join-Path $tempRoot "missing") }
  Assert-True ($missingRestore -match "DATA_NOT_RESTORED") "Restore alegou recuperação sem vault"

  $completeVault = Join-Path $tempRoot "restore-complete"
  New-Item -ItemType Directory -Path $completeVault | Out-Null
  Set-Content -LiteralPath (Join-Path $completeVault "AGENTS.md") -Value "# Preservar"
  Set-Content -LiteralPath (Join-Path $completeVault "00 - Open Mind.md") -Value "# Mapa"
  $completeBefore = @(Get-ChildItem -LiteralPath $completeVault -Force | ForEach-Object { $_.Name } | Sort-Object)
  $completeOutput = Invoke-Script -Path $bootstrap -Arguments @{ Mode = "Restore"; VaultPath = $completeVault }
  Assert-True ($completeOutput -match "RECONNECT_READY") "Restore não preparou reconexão de vault completo"
  Assert-True (-not ($completeOutput -match "RECONNECT_INCOMPLETE")) "Restore marcou vault completo como incompleto"
  $completeAfter = @(Get-ChildItem -LiteralPath $completeVault -Force | ForEach-Object { $_.Name } | Sort-Object)
  Assert-True (($completeBefore -join "|") -eq ($completeAfter -join "|")) "Restore criou ou removeu itens no vault"

  $agentsOnlyVault = Join-Path $tempRoot "restore-agents-only"
  New-Item -ItemType Directory -Path $agentsOnlyVault | Out-Null
  Set-Content -LiteralPath (Join-Path $agentsOnlyVault "AGENTS.md") -Value "# Preservar"
  $agentsOnlyOutput = Invoke-Script -Path $bootstrap -Arguments @{ Mode = "Restore"; VaultPath = $agentsOnlyVault }
  Assert-True ($agentsOnlyOutput -match "RECONNECT_INCOMPLETE") "Restore marcou como pronto um vault sem o mapa"
  Assert-True ($agentsOnlyOutput -match "00 - Open Mind\.md") "Restore não informou o arquivo-base ausente"
  Assert-True (-not (Test-Path (Join-Path $agentsOnlyVault "inbox"))) "Restore criou diretórios em vault incompleto"

  $mapOnlyVault = Join-Path $tempRoot "restore-map-only"
  New-Item -ItemType Directory -Path $mapOnlyVault | Out-Null
  Set-Content -LiteralPath (Join-Path $mapOnlyVault "00 - Open Mind.md") -Value "# Mapa"
  $mapOnlyOutput = Invoke-Script -Path $bootstrap -Arguments @{ Mode = "Restore"; VaultPath = $mapOnlyVault }
  Assert-True ($mapOnlyOutput -match "RECONNECT_INCOMPLETE") "Restore marcou como pronto um vault sem AGENTS.md"
  Assert-True ($mapOnlyOutput -match "AGENTS\.md") "Restore não informou AGENTS.md ausente"
  Assert-True (-not (Test-Path (Join-Path $mapOnlyVault "inbox"))) "Restore criou diretórios em vault incompleto"

  $emptyVault = Join-Path $tempRoot "restore-empty"
  New-Item -ItemType Directory -Path $emptyVault | Out-Null
  $emptyOutput = Invoke-Script -Path $bootstrap -Arguments @{ Mode = "Restore"; VaultPath = $emptyVault }
  Assert-True ($emptyOutput -match "RECONNECT_INCOMPLETE") "Restore marcou diretório vazio como pronto"
  Assert-True (@(Get-ChildItem -LiteralPath $emptyVault -Force).Count -eq 0) "Restore criou itens em diretório vazio"

  $nonCanonicalRestore = Invoke-Script -Path $bootstrap -Arguments @{ Mode = "Restore"; VaultPath = $nonCanonical }
  Assert-True ($nonCanonicalRestore -match "NON_CANONICAL") "Restore não diagnosticou a estrutura não canônica"
  Assert-True (-not (Test-Path (Join-Path $nonCanonical "inbox"))) "Restore criou estrutura paralela"
  $nonCanonicalInstall = Invoke-Script -Path $bootstrap -Arguments @{ Mode = "Install"; VaultPath = $nonCanonical; InitializeVault = $true }
  Assert-True ($nonCanonicalInstall -match "NON_CANONICAL") "Install alegou sucesso em vault não canônico"
  Assert-True (-not (Test-Path (Join-Path $nonCanonical "inbox"))) "Install criou estrutura paralela"

  $installVault = Join-Path $tempRoot "install-vault"
  New-Item -ItemType Directory -Path $installVault | Out-Null
  $installWhatIf = Invoke-Script -Path $bootstrap -Arguments @{ Mode = "Install"; VaultPath = $installVault; InitializeVault = $true; WhatIf = $true }
  Assert-True ($installWhatIf -match "PLANNED: inbox") "Install -WhatIf deve apresentar as pastas planejadas"
  Assert-True (-not (Test-Path (Join-Path $installVault "inbox"))) "Install -WhatIf criou pastas"

  $update = Invoke-Script -Path $bootstrap -Arguments @{ Mode = "Update" }
  Assert-True ($update -match "UPDATE_PLAN") "Update deve ser somente planejamento"

  Write-Output "PASS: testes de bootstrap/setup em fixture temporária"
}
finally {
  if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
