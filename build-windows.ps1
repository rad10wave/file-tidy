$ErrorActionPreference = "Stop"

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($Arguments -join ' ')"
    }
}

$projectRoot = $PSScriptRoot
$runtimeRootCandidates = @()
if ($env:CODEX_RUNTIME_ROOT) {
    $runtimeRootCandidates += $env:CODEX_RUNTIME_ROOT
}
if ($env:USERPROFILE) {
    $runtimeRootCandidates += (Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime")
}
if ($env:LOCALAPPDATA) {
    $runtimeRootCandidates += (Join-Path $env:LOCALAPPDATA "codex-runtimes\codex-primary-runtime")
}

$bundledRuntimeRoot = $runtimeRootCandidates |
    Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ "dependencies\node\bin\node.exe") -PathType Leaf) } |
    Select-Object -First 1

Push-Location $projectRoot
try {
    if ($bundledRuntimeRoot) {
        $bundledNode = Join-Path $bundledRuntimeRoot "dependencies\node\bin\node.exe"
        $bundledPnpm = Join-Path $bundledRuntimeRoot "dependencies\node\node_modules\pnpm\bin\pnpm.cjs"
        if (-not (Test-Path -LiteralPath $bundledPnpm -PathType Leaf)) {
            throw "The bundled Node runtime was found, but its pnpm entry point is missing."
        }

        $previousPath = $env:Path
        try {
            $env:Path = "$(Split-Path -Parent $bundledNode);$previousPath"
            Invoke-NativeCommand -FilePath $bundledNode -Arguments @($bundledPnpm, "install")
            Invoke-NativeCommand -FilePath $bundledNode -Arguments @($bundledPnpm, "dist:win")
        }
        finally {
            $env:Path = $previousPath
        }
    }
    else {
        $pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
        if (-not $pnpmCommand) {
            throw "pnpm was not found. Install pnpm or provide a bundled Codex runtime."
        }
        Invoke-NativeCommand -FilePath $pnpmCommand.Source -Arguments @("install")
        Invoke-NativeCommand -FilePath $pnpmCommand.Source -Arguments @("dist:win")
    }
}
finally {
    Pop-Location
}
