#requires -Version 5.1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../public/Update-Uchikomi.ps1')
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Assert-True($Condition, [string]$Message) { if (!$Condition) { throw $Message } }
function Expect-Error([scriptblock]$Action, [string]$Pattern) {
    try { & $Action } catch {
        if ($_.Exception.Message -notmatch $Pattern) { throw }
        return
    }
    throw "Expected failure matching $Pattern"
}

$temp = Join-Path ([IO.Path]::GetTempPath()) ('uchikomi-test-' + [Guid]::NewGuid())
$root = Join-Path $temp 'managed path'
$active = Join-Path $root 'Extension'
$template = Join-Path $temp 'package'
$archive = Join-Path $temp 'fixture.zip'
$null = [IO.Directory]::CreateDirectory($template)
$null = [IO.Directory]::CreateDirectory($root)
$running = $false
$downloads = 0

& {
    $processes = @([pscustomobject]@{ SessionId = 123; OwnerSid = 'S-1-5-19' })
    function Get-CimInstance { $processes }
    function Invoke-CimMethod($InputObject) { @{ Sid = $InputObject.OwnerSid } }
    Assert-True (!(Test-ChromeRunning)) 'Another Windows user blocked updates'
    $processes[0].OwnerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    Assert-True (Test-ChromeRunning) 'Missed own Chrome in another session'
}

function New-Fixture([string]$Version) {
    $manifest = Get-Content -Raw -Encoding UTF8 (Join-Path $PSScriptRoot '../public/manifest.json') | ConvertFrom-Json
    $manifest.version = $Version
    $manifest | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 (Join-Path $template 'manifest.json')
    if (Test-Path $archive) { Remove-Item $archive }
    [IO.Compression.ZipFile]::CreateFromDirectory($template, $archive)
    $asset = "uchikomi-extension-v$Version.zip"
    $script:releaseFixture = @{
        tag_name = "v$Version"; draft = $false; prerelease = $false
        assets = @(@{name=$asset; state='uploaded'; browser_download_url="$releaseBase/v$Version/$asset";
                      digest='sha256:' + (Get-FileHash $archive).Hash})
    }
}
function Get-OfficialRelease { return $releaseFixture }
function Test-ChromeRunning { return $running }
function Save-ReleaseZip([string]$Url, [string]$Destination) {
    $script:downloads++
    Copy-Item $archive $Destination
}

try {
    New-Fixture '1.6.0'
    Update-Extension $root
    Assert-True ((Get-ExtensionVersion $active) -eq [version]'1.6.0') 'First install failed'
    Update-Extension $root
    New-Fixture '1.5.0'
    Update-Extension $root
    Assert-True ($downloads -eq 1) 'Repeated check or downgrade downloaded a package'

    New-Fixture '1.7.0'
    $running = $true
    Update-Extension $root
    $running = $false
    Assert-True ($downloads -eq 1) 'Updated while Chrome was running'
    $digest = $releaseFixture.assets[0].digest
    $releaseFixture.assets[0].digest = 'sha256:' + ('0' * 64)
    Expect-Error { Update-Extension $root } 'checksum'
    $releaseFixture.assets[0].digest = $digest
    Assert-True ((Get-ExtensionVersion $active) -eq [version]'1.6.0') 'Bad ZIP replaced existing files'

    $manifestFile = Join-Path $template 'manifest.json'
    $manifest = Get-Content -Raw -Encoding UTF8 $manifestFile | ConvertFrom-Json
    $manifest.key = 'AA=='
    $manifest | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 $manifestFile
    Remove-Item $archive
    [IO.Compression.ZipFile]::CreateFromDirectory($template, $archive)
    $releaseFixture.assets[0].digest = 'sha256:' + (Get-FileHash $archive).Hash
    Expect-Error { Update-Extension $root } 'identity'
    Assert-True ((Get-ExtensionVersion $active) -eq [version]'1.6.0') 'Wrong extension replaced existing files'

    # Simulate interruption between the two renames, then retry with a good ZIP.
    [IO.Directory]::Move($active, (Join-Path $root 'Previous'))
    $running = $true
    Update-Extension $root
    Assert-True ((Get-ExtensionVersion $active) -eq [version]'1.6.0') 'Rollback did not recover original files'
    $running = $false
    New-Fixture '1.7.0'
    Update-Extension $root
    Assert-True ((Get-ExtensionVersion $active) -eq [version]'1.7.0') 'Update did not reuse install path'
    $null = [IO.Directory]::CreateDirectory((Join-Path $root 'Previous'))
    Update-Extension $root
    Assert-True (@(Get-ChildItem $root -Directory).Count -eq 1) 'Extra extension directories remained'

    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $taskName = 'UCHIKOMI CI ' + [Guid]::NewGuid()
    try {
        Register-UpdateTask $taskName (Join-Path $root 'Update-Uchikomi.ps1') $sid
        $task = Get-ScheduledTask -TaskName $taskName
        Assert-True ($task.Actions.Arguments -like '*-Mode Update') 'Scheduled command is not an update'
        Assert-True ($task.Principal.RunLevel -eq 'Limited') 'Scheduled task is not a limited user task'
        Assert-True ($task.Triggers.Count -eq 2) 'Missing logon or repeating trigger'
    } finally {
        if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        }
    }
    Write-Host 'Windows ZIP update checks passed.'
} finally { Remove-Item -LiteralPath $temp -Force -Recurse }
