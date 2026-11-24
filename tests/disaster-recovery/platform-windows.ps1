[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$PackageRoot,
  [Parameter(Mandatory=$true)][string]$Cli,
  [string]$Evidence = (Join-Path (Get-Location) "artifacts/disaster-recovery/platform-windows-$(Get-Date -Format yyyyMMddTHHmmss)-$PID")
)
$ErrorActionPreference = 'Stop'
trap { Write-Error ("Windows DR failed at line $($_.InvocationInfo.ScriptLineNumber): $($_.Exception.Message)"); break }
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$Work = Join-Path $env:TEMP ("sh-dr-windows-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Work | Out-Null
$Owner = (Resolve-Path $Work).Path
$ServerProcess = $null
$Pass = 'synthetic Windows platform passphrase 灾备'
$Runtime = Join-Path $PackageRoot 'runtime/node.exe'
$AppRoot = if (Test-Path (Join-Path $PackageRoot 'app/apps/api/dist/server.mjs')) { Join-Path $PackageRoot 'app' } else { $PackageRoot }
$Server = Join-Path $AppRoot 'apps/api/dist/server.mjs'
$Migrations = Join-Path $AppRoot 'packages/db/migrations'
$Source = Join-Path $Work 'source-data'
$Restored = Join-Path $Work 'restored'
$Package = Join-Path $Work 'backup.shbackup'
$Fixture = Join-Path $Work 'fixture.json'
$env:SEARCH_HUB_INSTALL_DIR = $PackageRoot
$env:NODE_NO_WARNINGS = '1'
# Some Windows hosts expose both Path and PATH. Start-Process builds a
# case-insensitive dictionary from that block and otherwise fails before boot.
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Process')
[Environment]::SetEnvironmentVariable('PATH', $null, 'Process')
[Environment]::SetEnvironmentVariable('Path', $machinePath, 'Process')

function Get-FreePort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port } finally { $listener.Stop() }
}
function Start-Server([string]$Data, [string]$Log) {
  $port = Get-FreePort
  $env:SEARCH_HUB_DATA_DIR = $Data
  $env:SEARCH_HUB_DB_PATH = Join-Path $Data 'search-hub.db'
  $env:SEARCH_HUB_PORT = "$port"
  $env:SEARCH_HUB_HOST = '127.0.0.1'
  $env:SEARCH_HUB_MIGRATIONS_DIR = $Migrations
  $env:SEARCH_HUB_ENCRYPTION_KEY = ''
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $Runtime
  $startInfo.WorkingDirectory = $PackageRoot
  $startInfo.Arguments = '"' + $Server + '"'
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $script:ServerProcess = [System.Diagnostics.Process]::Start($startInfo)
  $script:ServerLog = $Log
  $script:ServerStdoutTask = $script:ServerProcess.StandardOutput.ReadToEndAsync()
  $script:ServerStderrTask = $script:ServerProcess.StandardError.ReadToEndAsync()
  foreach ($_ in 1..60) {
    try { $response = Invoke-RestMethod "http://127.0.0.1:$port/api/health"; if ($response.status -eq 'ok') { return $port } } catch {}
    Start-Sleep -Seconds 1
  }
  throw "server did not become healthy: $Log"
}
function Stop-Server {
  if ($null -ne $script:ServerProcess) {
    if (-not $script:ServerProcess.HasExited) {
      $script:ServerProcess.Kill()
      $script:ServerProcess.WaitForExit()
    }
    [System.IO.File]::WriteAllText($script:ServerLog, $script:ServerStdoutTask.GetAwaiter().GetResult())
    [System.IO.File]::WriteAllText("$script:ServerLog.err", $script:ServerStderrTask.GetAwaiter().GetResult())
    $script:ServerProcess.Dispose()
  }
  $script:ServerProcess = $null
}
function Invoke-Backup([string[]]$Arguments, [string]$Log) {
  $previousErrorPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $Pass | & $Cli @Arguments 2>&1 | Tee-Object -FilePath $Log }
  finally { $ErrorActionPreference = $previousErrorPreference }
  if ($LASTEXITCODE -ne 0) { throw "backup command failed ($LASTEXITCODE): $($Arguments -join ' ')" }
}
function Invoke-ExpectedBackupFailure([string[]]$Arguments, [string]$Log) {
  $previousErrorPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $Pass | & $Cli @Arguments *> $Log; $code = $LASTEXITCODE }
  finally { $ErrorActionPreference = $previousErrorPreference }
  if ($code -eq 0) { throw "backup command unexpectedly succeeded: $($Arguments -join ' ')" }
}

New-Item -ItemType Directory -Path $Source,$Evidence | Out-Null
$null = New-Item -ItemType File -Path (Join-Path $Work 'passphrase') -Value $Pass
icacls (Join-Path $Work 'passphrase') /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null
try {
  $sourcePort = Start-Server $Source (Join-Path $Evidence 'source-server.log')
  & $Runtime (Join-Path $Repo 'tests/disaster-recovery/api-fixture.mjs') seed "http://127.0.0.1:$sourcePort" $Source $Fixture | Tee-Object (Join-Path $Evidence 'seed.json')
  if ($LASTEXITCODE -ne 0) { throw 'source fixture seed failed' }
  Stop-Server

  Invoke-Backup @('backup','create','--data-dir',$Source,'--output',$Package,'--passphrase-stdin','--json') (Join-Path $Evidence 'create.json')
  Invoke-Backup @('backup','verify',$Package,'--passphrase-stdin','--json') (Join-Path $Evidence 'verify.json')
  Invoke-Backup @('backup','restore',$Package,'--data-dir',$Restored,'--passphrase-stdin','--json') (Join-Path $Evidence 'dry-run.json')
  if (Test-Path $Restored) { throw 'dry-run created restore target' }
  $env:SEARCH_HUB_MIGRATIONS_DIR = $Migrations
  $env:SEARCH_HUB_APP_ENTRY = $Server
  Invoke-Backup @('backup','restore',$Package,'--data-dir',$Restored,'--apply','--start-check','--passphrase-stdin','--json') (Join-Path $Evidence 'apply.json')

  $originData = $env:SEARCH_HUB_DATA_DIR
  $originDb = $env:SEARCH_HUB_DB_PATH
  $restoredPort = Start-Server $Restored (Join-Path $Evidence 'restored-server.log')
  Invoke-RestMethod "http://127.0.0.1:$restoredPort/api/health" | ConvertTo-Json | Set-Content (Join-Path $Evidence 'health.json')
  & $Runtime (Join-Path $Repo 'tests/disaster-recovery/api-fixture.mjs') verify "http://127.0.0.1:$restoredPort" $Restored $Fixture | Tee-Object (Join-Path $Evidence 'restored-verify.json')
  if ($LASTEXITCODE -ne 0) { throw 'restored API/MCP verification failed' }
  Stop-Server
  $env:SEARCH_HUB_DATA_DIR = $originData
  $env:SEARCH_HUB_DB_PATH = $originDb

  $nonEmpty = Join-Path $Work 'non-empty'
  New-Item -ItemType Directory $nonEmpty | Out-Null
  Set-Content (Join-Path $nonEmpty 'sentinel') 'unchanged'
  $before = (Get-FileHash (Join-Path $nonEmpty 'sentinel')).Hash
  Invoke-ExpectedBackupFailure @('backup','restore',$Package,'--data-dir',$nonEmpty,'--apply','--passphrase-stdin','--json') (Join-Path $Evidence 'nonempty-target.json')
  if ($before -ne (Get-FileHash (Join-Path $nonEmpty 'sentinel')).Hash) { throw 'non-empty target was not safely refused' }

  $before = (Get-FileHash (Join-Path $Restored 'search-hub.db')).Hash
  Invoke-ExpectedBackupFailure @('backup','restore',$Package,'--data-dir',$Restored,'--apply','--passphrase-stdin','--json') (Join-Path $Evidence 'repeat-restore.json')
  if ($before -ne (Get-FileHash (Join-Path $Restored 'search-hub.db')).Hash) { throw 'repeat restore changed existing target' }

  $outside = Join-Path $Work 'outside'
  New-Item -ItemType Directory $outside | Out-Null
  $junction = Join-Path $Work 'junction'
  New-Item -ItemType Junction -Path $junction -Target $outside | Out-Null
  Invoke-ExpectedBackupFailure @('backup','restore',$Package,'--data-dir',(Join-Path $junction 'restored'),'--apply','--passphrase-stdin','--json') (Join-Path $Evidence 'junction-target.json')
  if ((Get-ChildItem $outside | Measure-Object).Count -ne 0) { throw 'junction ancestor was not safely refused' }

  $long = Join-Path $Work ((('a' * 32) + '/') + (('b' * 32) + '/') + (('灾备' * 12) + '/restored'))
  New-Item -ItemType Directory (Split-Path $long) -Force | Out-Null
  Invoke-Backup @('backup','restore',$Package,'--data-dir',$long,'--apply','--passphrase-stdin','--json') (Join-Path $Evidence 'long-unicode-path.json')
  if (-not (Test-Path (Join-Path $long 'search-hub.db'))) { throw 'long Unicode path restore missing DB' }

  icacls $Package | Set-Content (Join-Path $Evidence 'package-acl.txt')
  icacls (Join-Path $Restored 'master.key') | Set-Content (Join-Path $Evidence 'key-acl.txt')
  $aclText = @((Get-Content (Join-Path $Evidence 'package-acl.txt')), (Get-Content (Join-Path $Evidence 'key-acl.txt'))) -join "`n"
  if ($aclText -match 'Everyone|BUILTIN\\Users') { throw 'broad Windows ACL found' }

  $statuses = '{"R02":"PASS","R12":"PASS","R13":"PASS","R14":"PASS","R17":"PASS","R18":"PASS","R19":"PASS","R21":"PASS","R26":"PASS","R30":"PASS","R38":"PASS"}'
  $evidenceMap = '{"R02":["create.json","restored-verify.json"],"R12":["restored-verify.json"],"R13":["restored-verify.json"],"R14":["restored-verify.json"],"R17":["restored-verify.json"],"R18":["restored-verify.json"],"R19":["create.json","verify.json","apply.json"],"R21":["nonempty-target.json","junction-target.json"],"R26":["package-acl.txt","key-acl.txt","junction-target.json","long-unicode-path.json"],"R30":["health.json","restored-verify.json"],"R38":["repeat-restore.json"]}'
  $statusesPath = Join-Path $Evidence 'platform-statuses.json'
  $evidenceMapPath = Join-Path $Evidence 'platform-evidence-map.json'
  Set-Content -LiteralPath $statusesPath -Value $statuses -Encoding ASCII
  Set-Content -LiteralPath $evidenceMapPath -Value $evidenceMap -Encoding ASCII
  & $Runtime (Join-Path $Repo 'tests/disaster-recovery/write-platform-report.mjs') --evidence-dir $Evidence --kind search-hub-platform-windows --verdict PASS --statuses-file $statusesPath --evidence-map-file $evidenceMapPath
  if ($LASTEXITCODE -ne 0) { throw 'platform report generation failed' }
  Write-Output "PASS: Windows packaged DR drill evidence=$Evidence"
}
finally {
  Stop-Server
  if (Test-Path $Work) {
    $current = (Resolve-Path $Work).Path
    if ($current.Equals($Owner,[System.StringComparison]::OrdinalIgnoreCase)) { Remove-Item $Work -Recurse -Force }
    else { Write-Error "BLOCKED: owned Windows work path changed: $Work" }
  }
}
