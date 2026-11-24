#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory = $false)][ValidateSet('Install','Update','Disable')][string]$Mode)

$ErrorActionPreference = 'Stop'
$releaseBase = 'https://github.com/otomatty/uchikomi/releases/download'
$keyHash = 'c00bc7a9f8fab57ca1a595d1bc227ed2e37b363e964c22df9fb058bc9fa3fab2'

function Get-ExtensionVersion([string]$Directory) {
    $manifest = Get-Content -LiteralPath (Join-Path $Directory 'manifest.json') -Encoding UTF8 -Raw | ConvertFrom-Json
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = [BitConverter]::ToString($sha.ComputeHash([Convert]::FromBase64String($manifest.key))).Replace('-', '')
    } finally { $sha.Dispose() }
    if ($manifest.manifest_version -ne 3 -or $hash -ne $keyHash) {
        throw "Unexpected extension identity in $Directory"
    }
    return [version]$manifest.version
}

function Get-OfficialRelease {
    Invoke-RestMethod -Uri 'https://api.github.com/repos/otomatty/uchikomi/releases/latest' -TimeoutSec 30
}

function Save-ReleaseZip([string]$Url, [string]$Destination) {
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination -TimeoutSec 300
}

function Test-ChromeRunning {
    return [bool](Get-Process -Name chrome -ErrorAction SilentlyContinue)
}

function Update-Extension([string]$Root) {
    $active = Join-Path $Root 'Extension'
    $previous = Join-Path $Root 'Previous'
    if (Test-Path -LiteralPath $previous) {
        $null = Get-ExtensionVersion $previous
        if (!(Test-Path -LiteralPath $active)) {
            [IO.Directory]::Move($previous, $active)
        } else {
            $null = Get-ExtensionVersion $active
            Remove-Item -LiteralPath $previous -Force -Recurse
        }
    }
    $installed = $null
    if (Test-Path -LiteralPath $active) {
        $installed = Get-ExtensionVersion $active
        if (Test-ChromeRunning) { Write-Host 'Update deferred until Chrome exits.'; return }
    }

    $release = Get-OfficialRelease
    $tag = $release.tag_name
    if ($release.draft -or $release.prerelease -or $tag -cnotmatch '^v(\d+\.\d+\.\d+)$') {
        throw 'Invalid stable release tag.'
    }
    $version = [version]$tag.Substring(1)
    if ($null -ne $installed -and $version -le $installed) { return }
    $name = "uchikomi-extension-$tag.zip"
    $assets = @($release.assets | Where-Object { $_.name -ceq $name })
    $url = "$releaseBase/$tag/$name"
    if ($assets.Count -ne 1 -or $assets[0].browser_download_url -cne $url -or
        $assets[0].state -ne 'uploaded' -or $assets[0].digest -notmatch '^sha256:[a-f0-9]{64}$') {
        throw "Cannot verify the release asset for $tag."
    }

    $work = Join-Path $Root ('staging-' + [Guid]::NewGuid())
    $null = [IO.Directory]::CreateDirectory($work)
    try {
        $zip = Join-Path $work $name
        Save-ReleaseZip $url $zip
        $digest = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
        if ("sha256:$digest" -ne $assets[0].digest) { throw 'ZIP checksum mismatch.' }
        $staged = Join-Path $work 'Extension'
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::ExtractToDirectory($zip, $staged)
        if ((Get-ExtensionVersion $staged) -ne $version) { throw 'ZIP manifest version mismatch.' }
        if ($null -ne $installed) {
            if (Test-ChromeRunning) { Write-Host 'Update deferred until Chrome exits.'; return }
            [IO.Directory]::Move($active, $previous)
        }
        try {
            [IO.Directory]::Move($staged, $active)
        } catch {
            if (Test-Path -LiteralPath $previous) { [IO.Directory]::Move($previous, $active) }
            throw
        }
        if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Force -Recurse }
        Write-Host "Installed UCHIKOMI $tag in $active"
    } finally {
        Remove-Item -LiteralPath $work -Force -Recurse
    }
}

function Register-UpdateTask([string]$TaskName, [string]$ScriptFile, [string]$UserId) {
    $powershell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
    $action = New-ScheduledTaskAction -Execute $powershell -Argument (
        '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "{0}" -Mode Update' -f $ScriptFile)
    $logon = New-ScheduledTaskTrigger -AtLogOn -User $UserId
    $timer = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(15) -RepetitionInterval (New-TimeSpan -Minutes 15)
    $principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($logon, $timer) -Principal $principal -Settings $settings -Force | Out-Null
}

function Invoke-WindowsUpdater([string]$Operation, [string]$SourceFile) {
    if (!$Operation) { throw 'Choose -Mode Install, Update or Disable. See the installation guide in README.md.' }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $taskName = "UCHIKOMI ZIP Update $sid"
    $root = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'UCHIKOMI'
    if ($Operation -eq 'Disable') {
        if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        }
        Write-Host 'Automatic updates disabled.'
        return
    }
    $null = [IO.Directory]::CreateDirectory($root)
    # Manual updates and the scheduled task share the same lock.
    $lock = [IO.File]::Open((Join-Path $root 'update.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Update-Extension $root
        if ($Operation -eq 'Install') {
            $helper = Join-Path $root 'Update-Uchikomi.ps1'
            if ($SourceFile -ne $helper) { Copy-Item -LiteralPath $SourceFile -Destination $helper -Force }
            Register-UpdateTask $taskName $helper $sid
            Write-Host "Automatic updates enabled. In chrome://extensions load: $(Join-Path $root 'Extension')"
        }
    } finally { $lock.Dispose() }
}

if ($MyInvocation.InvocationName -ne '.') {
    Invoke-WindowsUpdater $Mode $PSCommandPath
}
