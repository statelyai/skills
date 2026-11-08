$ErrorActionPreference = 'Stop'
$taskArguments = @($args)

# Follow launcher links before locating the adjacent ESM entrypoint.
$launcher = Get-Item -LiteralPath $PSCommandPath -Force
for ($depth = 0; $launcher.LinkType; $depth++) {
  if ($depth -ge 64) { throw 'Stately launcher link cycle.' }
  $target = @($launcher.Target)[0]
  if (-not [IO.Path]::IsPathRooted($target)) {
    $target = Join-Path $launcher.DirectoryName $target
  }
  $launcher = Get-Item -LiteralPath $target -Force
}
$entry = Join-Path $launcher.DirectoryName 'stately-check.mjs'

function Get-StatelyRuntime([string] $name) {
  $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $command) { return $null }
  $text = (& $command.Source --version 2>$null | Select-Object -First 1)
  $match = [regex]::Match([string]$text, '(\d+)\.(\d+)\.(\d+)')
  if (-not $match.Success) { return $null }
  return @{ binary = $command.Source; version = [version]$match.Value }
}

$runtime = Get-StatelyRuntime 'node'
if ($runtime -and ($runtime.version -ge [version]'23.6.0' -or
    ($runtime.version -ge [version]'22.18.0' -and $runtime.version -lt [version]'23.0.0'))) {
  $invokeArguments = @('--disable-warning=ExperimentalWarning', $entry) + $taskArguments
} else {
  $runtime = Get-StatelyRuntime 'bun'
  if ($runtime -and $runtime.version -ge [version]'1.1.5') {
    $invokeArguments = @($entry) + $taskArguments
  } else {
    $runtime = Get-StatelyRuntime 'deno'
    if ($runtime -and $runtime.version -ge [version]'2.0.0') {
      $invokeArguments = @('run', '--quiet', '--no-prompt', '--allow-all', $entry) + $taskArguments
    } else {
      [Console]::Error.WriteLine('stately-check needs Node 22.18 to 22.x, Node 23.6+, Bun 1.1.5+, or Deno 2.0+.')
      exit 127
    }
  }
}
if ($env:STATELY_LAUNCHER_DEBUG -eq '1') {
  [Console]::Error.WriteLine((@{ binary = $runtime.binary; entry = $entry; arguments = $invokeArguments } | ConvertTo-Json -Compress -Depth 4))
}
& $runtime.binary @invokeArguments
exit $LASTEXITCODE
