# OutDir: where the adapter looks for the build (the `engine` folder beside its config.json); the repo's own by default.
param([string]$OutDir)
$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../../..'))
$runtimeDir = if ($OutDir) { [IO.Path]::GetFullPath($OutDir) } else { Join-Path $workspaceRoot '.host\wechat\engine' }
$source = Join-Path $PSScriptRoot 'bridge.cpp'
$sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
$outputDir = Join-Path $runtimeDir $sourceHash.Substring(0,12)
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $installation) { throw '需要 Visual Studio C++ x64 构建工具' }
$vcvars = Join-Path $installation 'VC\Auxiliary\Build\vcvars64.bat'
$dll = Join-Path $outputDir 'dsh-wechat.dll'
$command = 'cl /nologo /std:c++17 /O2 /MT /EHsc /LD /utf-8 "' + $source + '" /Fo"' + (Join-Path $outputDir 'bridge.obj') + '" /link /OUT:"' + $dll + '" /IMPLIB:"' + (Join-Path $outputDir 'bridge.lib') + '"'
$buildScript = Join-Path $outputDir 'build.cmd'
@('@echo off', ('call "' + $vcvars + '" >nul'), 'if errorlevel 1 exit /b 1', $command, 'exit /b %errorlevel%') | Set-Content -LiteralPath $buildScript -Encoding utf8
& $env:ComSpec /d /c $buildScript
if ($LASTEXITCODE -ne 0) { throw '原生桥构建失败' }
@{file=$dll; sha256=(Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash.ToLowerInvariant(); sourceSha256=$sourceHash} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeDir 'current.json') -Encoding utf8
# Older builds are never loaded again (current.json names only this one); one WeChat still holds open is left for next time.
Get-ChildItem -LiteralPath $runtimeDir -Directory | Where-Object { $_.Name -match '^[0-9a-f]{12}$' -and $_.FullName -ne $outputDir } | ForEach-Object {
  try { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop } catch { Write-Output "旧构建暂时删不掉，下次再删：$($_.Exception.Message)" }
}
Write-Output $dll
