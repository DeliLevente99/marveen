# Marveen - Windows natív telepítő
# Futtatás (rendes user, nem rendszergazda kell):
#   PowerShell: .\install-windows-native.ps1
#
# Telepíti a Marveen dashboardot Windows-on natívan (WSL nélkül). A
# régi `install-windows.ps1` WSL-bootstrap változat marad fallback-nek
# a `.\install-windows.ps1` parancsra. Ez a script a Windows-native
# port (lásd a `feature/windows-tmux-shim` branch commit-jait + a
# `src/platform/*` shim modulokat) eredménye, és Task Scheduler
# task-ot regisztrál ami felhasználói bejelentkezéskor auto-indítja a
# dashboardot.

$ErrorActionPreference = 'Stop'
$InstallDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $InstallDir

function Write-Step($n, $msg)  { Write-Host ""; Write-Host "[$n] $msg" -ForegroundColor White }
function Write-OK($msg)        { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Skip($msg)      { Write-Host "  ⊘ $msg" -ForegroundColor DarkGray }
function Write-Warn($msg)      { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Write-Fail($msg)      { Write-Host "  ✗ $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "  ▐▛███▜▌   Marveen" -ForegroundColor Cyan
Write-Host " ▝▜█████▛▘  Windows natív telepítő" -ForegroundColor Cyan
Write-Host "   ▘▘ ▝▝   (WSL nélkül; Task Scheduler auto-start)" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Install dir: $InstallDir" -ForegroundColor DarkGray
Write-Host ""

# --- 1. Prereq check (no auto-install -- operator chooses) ---

Write-Step '1/7' 'Előfeltételek ellenőrzése'

function Test-Cmd($name) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source } else { return $null }
}

$missing = @()

$nodePath = Test-Cmd 'node'
if ($nodePath) {
    $nodeVer = (& node -v).TrimStart('v')
    $nodeMajor = [int]($nodeVer.Split('.')[0])
    if ($nodeMajor -ge 20) {
        Write-OK "Node.js $nodeVer ($nodePath)"
    } else {
        Write-Fail "Node.js $nodeVer -- minimum v20 kell"
        $missing += 'OpenJS.NodeJS.LTS'
    }
} else {
    Write-Fail "Node.js nincs telepítve"; $missing += 'OpenJS.NodeJS.LTS'
}

$npmPath = Test-Cmd 'npm'
if ($npmPath) { Write-OK "npm $(& npm -v)" } else { Write-Fail "npm hiányzik"; $missing += 'OpenJS.NodeJS.LTS' }

$gitPath = Test-Cmd 'git'
if ($gitPath) { Write-OK "git ($(& git --version | Out-String -NoNewline))" } else { Write-Fail "git hiányzik"; $missing += 'Git.Git' }

$claudePath = Test-Cmd 'claude'
if ($claudePath) {
    Write-OK "Claude Code $(& claude --version 2>&1 | Select-Object -First 1)"
} else {
    Write-Fail "Claude Code CLI hiányzik"
    Write-Warn "Manuálisan: npm install -g @anthropic-ai/claude-code"
    $missing += 'manual:claude'
}

$bunPath = Test-Cmd 'bun'
if ($bunPath) { Write-OK "Bun $(& bun --version)" } else { Write-Warn "Bun hiányzik -- kell a Telegram plugin futtatásához"; $missing += 'Oven-sh.Bun' }

if ($missing.Count -gt 0) {
    Write-Host ""
    Write-Warn "Hiányzó előfeltételek. Telepítsd ezekkel a winget parancsokkal:"
    foreach ($pkg in ($missing | Where-Object { $_ -notlike 'manual:*' } | Select-Object -Unique)) {
        Write-Host "    winget install $pkg" -ForegroundColor Cyan
    }
    if ($missing -contains 'manual:claude') {
        Write-Host "    npm install -g @anthropic-ai/claude-code" -ForegroundColor Cyan
    }
    Write-Host ""
    $cont = Read-Host "Folytassam a telepítést mégis? (i/n) [n]"
    if ($cont -ne 'i') { Write-Host "Megszakítva." -ForegroundColor Yellow; exit 1 }
}

# --- 2. Native build prereqs (better-sqlite3, node-pty) ---

Write-Step '2/7' 'Native build előfeltételek'

$vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$hasCpp = $false
if (Test-Path $vsWhere) {
    $cppPaths = & $vsWhere -all -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
    if ($cppPaths) { $hasCpp = $true; Write-OK "Visual Studio C++ workload elérhető ($($cppPaths -join ', '))" }
}
if (-not $hasCpp) {
    Write-Warn "Visual Studio Build Tools (Desktop C++ workload) nem található."
    Write-Warn "better-sqlite3 + node-pty natív moduloknak kell:"
    Write-Host "    winget install Microsoft.VisualStudio.2022.BuildTools --override `"--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended`"" -ForegroundColor Cyan
    Write-Warn "Ezt manuálisan kell telepíteni (~6 GB, 20+ perc) -- folytatás után a build el fog hasalni."
}

# --- 3. .env interactive setup ---

Write-Step '3/7' 'Konfiguráció (.env)'

$envPath = Join-Path $InstallDir '.env'
if (Test-Path $envPath) {
    Write-Skip ".env létezik, nem írom felül. (Töröld manuálisan, ha új beállítást akarsz.)"
} else {
    Write-Host "  Telegram bot tokent szerezz be a @BotFather-től; chat ID-t pl. @userinfobot-tól." -ForegroundColor DarkGray
    $botToken = Read-Host "  TELEGRAM_BOT_TOKEN"
    $chatId   = Read-Host "  ALLOWED_CHAT_ID (a te chat ID-d)"
    $owner    = Read-Host "  OWNER_NAME (pl. Szabolcs)"
    $calId    = Read-Host "  HEARTBEAT_CALENDAR_ID (Google Calendar email, opcionális -- Enter kihagyja)"

    $envLines = @(
        "TELEGRAM_BOT_TOKEN=$botToken",
        "ALLOWED_CHAT_ID=$chatId",
        "OWNER_NAME=$owner",
        "CHANNEL_PROVIDER=telegram",
        "MARVEEN_ENV=windows"
    )
    if ($calId) { $envLines += "HEARTBEAT_CALENDAR_ID=$calId" }
    $envLines -join "`n" | Out-File -FilePath $envPath -Encoding utf8 -NoNewline

    # Tighten ACL on .env so other users on the machine can't read the
    # bot token. Uses the same icacls pattern as src/platform/file-acl.ts.
    & icacls $envPath /inheritance:r /grant:r "${env:USERDOMAIN}\${env:USERNAME}:(F)" 2>&1 | Out-Null
    Write-OK ".env elkészült (owner-only ACL)"
}

# --- 4. npm install + build ---

Write-Step '4/7' 'Függőségek telepítése + build'

Push-Location $InstallDir
try {
    Write-Host "  npm install..."
    & npm install
    if ($LASTEXITCODE -ne 0) { Write-Fail "npm install elhasalt"; exit 1 }
    Write-OK "node_modules telepítve"

    Write-Host "  npm run build..."
    & npm run build
    if ($LASTEXITCODE -ne 0) { Write-Fail "npm run build elhasalt"; exit 1 }
    Write-OK "dist/ build kész"
} finally { Pop-Location }

# --- 5. Claude plugin install (Telegram) ---

Write-Step '5/7' 'Telegram channels plugin telepítése'

if (-not $claudePath) {
    Write-Skip "Claude Code nincs telepítve, plugin telepítés kihagyva. Később futtasd kézzel:"
    Write-Host "    claude plugin install telegram@claude-plugins-official" -ForegroundColor Cyan
} else {
    & claude plugin install telegram@claude-plugins-official 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-OK "telegram plugin telepítve"
    } else {
        Write-Warn "Plugin install nem ment (claude be vagy jelentkezve? `claude` parancs futtat egy login flowt). Később:"
        Write-Host "    claude plugin install telegram@claude-plugins-official" -ForegroundColor Cyan
    }
}

# --- 6. Task Scheduler registration ---

Write-Step '6/7' 'Task Scheduler auto-start'

$taskName = "Marveen"
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask) {
    Write-Skip "Task '$taskName' már létezik. Frissítéshez töröld kézzel: Unregister-ScheduledTask -TaskName '$taskName'"
} else {
    $reg = Read-Host "Regisztráljam Task Schedulerbe (bejelentkezéskor auto-start)? (i/n) [i]"
    if ($reg -eq 'n') {
        Write-Skip "Task Scheduler regisztráció kihagyva. Indítás kézzel: cd '$InstallDir'; node dist/index.js"
    } else {
        $nodeExe = (Get-Command node).Source
        $distEntry = Join-Path $InstallDir 'dist\index.js'

        $action = New-ScheduledTaskAction -Execute $nodeExe -Argument "`"$distEntry`"" -WorkingDirectory $InstallDir
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User "${env:USERDOMAIN}\${env:USERNAME}"
        # Settings: restart on failure, no admin elevation, hidden console,
        # no time limit (the dashboard runs indefinitely).
        $settings = New-ScheduledTaskSettingsSet `
            -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries `
            -StartWhenAvailable `
            -ExecutionTimeLimit ([TimeSpan]::Zero) `
            -RestartCount 5 `
            -RestartInterval (New-TimeSpan -Minutes 1)
        $principal = New-ScheduledTaskPrincipal -UserId "${env:USERDOMAIN}\${env:USERNAME}" -LogonType Interactive -RunLevel Limited

        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
            -Settings $settings -Principal $principal -Description "Marveen dashboard auto-start" | Out-Null
        Write-OK "Task '$taskName' regisztrálva (bejelentkezéskor indul, crash után 1 percig vár majd újraindít, max 5x)"
    }
}

# --- 7. Start now + health check ---

Write-Step '7/7' 'Indítás és health check'

$startNow = Read-Host "Indítsam most a dashboardot? (i/n) [i]"
if ($startNow -eq 'n') {
    Write-Skip "Indítás kihagyva. Manuálisan: Start-ScheduledTask -TaskName '$taskName'  vagy:  node dist\index.js"
} else {
    if ($existingTask -or (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
        Start-ScheduledTask -TaskName $taskName
        Write-OK "Task elindítva"
    } else {
        # No task registered -- spawn directly via detached Start-Process so
        # the dashboard survives this script's exit.
        $nodeExe = (Get-Command node).Source
        $distEntry = Join-Path $InstallDir 'dist\index.js'
        Start-Process -FilePath $nodeExe -ArgumentList "`"$distEntry`"" -WorkingDirectory $InstallDir -WindowStyle Hidden
        Write-OK "Dashboard indítva detached node-folyamatként"
    }

    # Poll the dashboard's port for up to 20 seconds. Default WEB_PORT
    # is 3420; if the operator overrode in .env, this probe will miss --
    # but the script still exits cleanly.
    $port = 3420
    Write-Host "  Várok hogy a $port porton listenel-jen..."
    $deadline = [DateTime]::Now.AddSeconds(20)
    $up = $false
    while ([DateTime]::Now -lt $deadline) {
        if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
            $up = $true; break
        }
        Start-Sleep -Milliseconds 500
    }
    if ($up) {
        Write-OK "Dashboard fut: http://localhost:$port"
    } else {
        Write-Warn "Nem érzékeltem a $port portot 20s alatt. Nézd meg manuálisan a logot vagy a process-t."
    }
}

Write-Host ""
Write-Host "  Telepítés kész." -ForegroundColor Green
Write-Host "  Dashboard: http://localhost:3420" -ForegroundColor White
Write-Host "  Token a logban (Dashboard access URL sor) -- másold be böngészőbe." -ForegroundColor DarkGray
Write-Host "  Task Scheduler GUI: taskschd.msc -> Task Scheduler Library -> Marveen" -ForegroundColor DarkGray
Write-Host ""
