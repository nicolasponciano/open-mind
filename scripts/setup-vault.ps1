[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "Medium")]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$VaultPath
)

$ErrorActionPreference = "Stop"

# Esta e a unica lista operacional da estrutura inicial do vault.
$canonicalFolders = @(
  "inbox", "diario", "pessoas", "empresas", "clientes", "reunioes", "deals",
  "financas", "projetos", "conteudo", "conhecimento", "pessoal", "referencias", "arquivo",
  "conteudo/ideias", "conhecimento/raw", "conhecimento/wiki"
)
$canonicalRoots = @($canonicalFolders | ForEach-Object { ($_ -split "/")[0] } | Select-Object -Unique)

if (-not [IO.Path]::IsPathRooted($VaultPath)) {
  throw "VaultPath deve ser absoluto. Nenhuma alteracao foi feita."
}
# IsPathRooted aceita caminhos relativos a drive (ex.: C:rel); eles dependem do diretorio atual.
if ($VaultPath -match '^[A-Za-z]:(?![\\/])') {
  throw "VaultPath deve ser totalmente qualificado; caminhos relativos a drive nao sao aceitos. Nenhuma alteracao foi feita."
}
if (-not (Test-Path -LiteralPath $VaultPath -PathType Container)) {
  throw "VaultPath deve apontar para um diretorio existente. O script nao cria a raiz do vault."
}

$resolvedRoot = (Resolve-Path -LiteralPath $VaultPath).ProviderPath
$filesystemRoot = [IO.Path]::GetPathRoot($resolvedRoot).TrimEnd('\', '/')
if ($resolvedRoot.TrimEnd('\', '/') -eq $filesystemRoot) {
  throw "A raiz do filesystem nao pode ser usada como vault. Nenhuma alteracao foi feita."
}

$existingRootFolders = @(Get-ChildItem -LiteralPath $resolvedRoot -Directory -Force | Select-Object -ExpandProperty Name)
$missingCanonicalRoots = @($canonicalRoots | Where-Object { $_ -notin $existingRootFolders })
$foreignRootFolders = @($existingRootFolders | Where-Object { ($_ -notin $canonicalRoots) -and ($_ -ne ".obsidian") })
if ($missingCanonicalRoots.Count -gt 0 -and $foreignRootFolders.Count -gt 0) {
  Write-Output "DIAGNOSTIC: estrutura nao canonica detectada; nenhuma pasta foi criada."
  Write-Output ("Diretorios existentes preservados: " + ($foreignRootFolders -join ", "))
  return
}

foreach ($relativeFolder in $canonicalFolders) {
  $target = Join-Path $resolvedRoot ($relativeFolder -replace '/', [IO.Path]::DirectorySeparatorChar)
  if (Test-Path -LiteralPath $target) {
    $item = Get-Item -LiteralPath $target -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "O caminho contem junction ou link simbolico; operacao bloqueada: $relativeFolder."
    }
    if (-not $item.PSIsContainer) {
      throw "O caminho esperado para diretorio ja existe como arquivo: $relativeFolder. Nenhuma remocao foi feita."
    }
    Write-Output "EXISTS: $relativeFolder"
    continue
  }

  if ($PSCmdlet.ShouldProcess($relativeFolder, "Criar diretorio dentro do vault")) {
    try {
      New-Item -ItemType Directory -Path $target -ErrorAction Stop | Out-Null
      Write-Output "CREATED: $relativeFolder"
    }
    catch {
      throw "Falha ao criar '$relativeFolder'. Alteracoes anteriores foram preservadas; nenhuma reversao destrutiva foi tentada. Detalhe: $($_.Exception.Message)"
    }
  }
  else {
    Write-Output "PLANNED: $relativeFolder"
  }
}
