param(
  [ValidateSet("start", "restart", "shell", "logs", "stop", "rm", "remove", "status")]
  [string]$Action = "start"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..\..")

$Image = if ($env:CHORUS_IMAGE) { $env:CHORUS_IMAGE } else { "chorus:local" }
$Name = if ($env:CHORUS_CONTAINER_NAME) { $env:CHORUS_CONTAINER_NAME } else { "chorus" }
$Port = if ($env:CHORUS_PORT) { $env:CHORUS_PORT } else { "7878" }
$InstallAiClis = if ($env:CHORUS_INSTALL_AI_CLIS) { $env:CHORUS_INSTALL_AI_CLIS } else { "true" }
$DataDir = if ($env:CHORUS_DATA_DIR_HOST) { $env:CHORUS_DATA_DIR_HOST } else { Join-Path $env:USERPROFILE ".chorus-container\data" }
$HomeDir = if ($env:CHORUS_HOME_DIR_HOST) { $env:CHORUS_HOME_DIR_HOST } else { Join-Path $env:USERPROFILE ".chorus-container\home" }
$ConfigFile = if ($env:CHORUS_CONFIG_FILE) { $env:CHORUS_CONFIG_FILE } else { Join-Path $RepoRoot "chorus.config.json" }

function Get-ContainerRuntime {
  if ($env:CHORUS_CONTAINER_RUNTIME) {
    return $env:CHORUS_CONTAINER_RUNTIME
  }
  if (Get-Command docker -ErrorAction SilentlyContinue) {
    return "docker"
  }
  if (Get-Command podman -ErrorAction SilentlyContinue) {
    return "podman"
  }
  throw "Docker Desktop or Podman Desktop is required. Install one, then re-run this script."
}

function Initialize-HostDirs {
  $dirs = @(
    $DataDir,
    (Join-Path $HomeDir ".npm-global\bin"),
    (Join-Path $HomeDir ".config"),
    (Join-Path $HomeDir ".codex"),
    (Join-Path $HomeDir ".claude"),
    (Join-Path $HomeDir ".gemini"),
    (Join-Path $HomeDir ".ssh")
  )
  foreach ($dir in $dirs) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
}

function Add-InheritedEnvArgs {
  $keys = @(
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "CHORUS_ALLOW_REMOTE_TERMINAL"
  )
  $result = @()
  foreach ($key in $keys) {
    if ([Environment]::GetEnvironmentVariable($key)) {
      $result += @("--env", $key)
    }
  }
  return $result
}

function Start-ChorusContainer {
  param([string]$Runtime)

  Initialize-HostDirs

  $containerfile = Join-Path $RepoRoot "deploy\Containerfile"
  & $Runtime build `
    --build-arg "INSTALL_AI_CLIS=$InstallAiClis" `
    --tag $Image `
    --file $containerfile `
    $RepoRoot

  & $Runtime rm --force $Name 2>$null | Out-Null

  $runArgs = @(
    "run",
    "--detach",
    "--name", $Name,
    "--init",
    "--restart", "unless-stopped",
    "--publish", "127.0.0.1:${Port}:7878",
    "--env", "CHORUS_HOST=0.0.0.0",
    "--env", "CHORUS_PORT=7878",
    "--env", "CHORUS_DATA_DIR=/var/lib/chorus",
    "--env", "HOME=/home/chorus",
    "--volume", "${DataDir}:/var/lib/chorus",
    "--volume", "${HomeDir}:/home/chorus"
  )

  if (Test-Path $ConfigFile) {
    $resolvedConfig = Resolve-Path $ConfigFile
    $runArgs += @("--volume", "${resolvedConfig}:/app/chorus.config.json")
  }

  $runArgs += Add-InheritedEnvArgs
  $runArgs += $Image

  & $Runtime @runArgs
  Write-Host "Chorus is starting at http://127.0.0.1:$Port"
  Write-Host "Run '.\deploy\windows\run-container.ps1 logs' to follow logs or '.\deploy\windows\run-container.ps1 shell' to authenticate gh/codex/claude/gemini."
}

$Runtime = Get-ContainerRuntime

switch ($Action) {
  "start" { Start-ChorusContainer -Runtime $Runtime }
  "restart" { Start-ChorusContainer -Runtime $Runtime }
  "shell" { & $Runtime exec --interactive --tty $Name /bin/bash }
  "logs" { & $Runtime logs --follow $Name }
  "stop" { & $Runtime stop $Name }
  "rm" { & $Runtime rm --force $Name }
  "remove" { & $Runtime rm --force $Name }
  "status" { & $Runtime ps --all --filter "name=$Name" }
}
