@echo off
REM Marveen dashboard leallitas Windows-on.
REM
REM A dashboard processz a leallitaskor magaval rantja a Windows-on
REM spawn-olt channels session-t (stopMainChannelsSession, lasd
REM src/web/main-channels-session.ts:189), tehat itt eleg a Node
REM processzfat lekonyitani. /T flag a child pty/claude folyamatokat
REM is leszedi (force-kill - a graceful shutdown handler 5 sec-es
REM hard-kill timeout-ja amugy is ezt csinalna).

setlocal enableextensions enabledelayedexpansion
cd /d "%~dp0.."

if not exist "store\claudeclaw.pid" (
    echo [INFO] Nincs pidfile - Marveen valoszinuleg nem fut.
    exit /b 0
)

set "PID="
for /f "usebackq tokens=*" %%i in ("store\claudeclaw.pid") do set "PID=%%i"

if not defined PID (
    echo [INFO] Pidfile ures, takaritas.
    del "store\claudeclaw.pid" 2>nul
    exit /b 0
)

tasklist /FI "PID eq !PID!" /FO CSV /NH 2>nul | findstr /I "node.exe" >nul
if errorlevel 1 (
    echo [INFO] PID !PID! mar nem el - stale pidfile, takaritas.
    del "store\claudeclaw.pid" 2>nul
    exit /b 0
)

echo Marveen (PID !PID!^) leallitasa...
taskkill /F /T /PID !PID! >nul 2>&1
if errorlevel 1 (
    echo [HIBA] taskkill nem sikerult PID !PID!-re.
    exit /b 1
)

REM Force-kill utan a graceful releaseLock() nem fut le, kezzel takaritjuk.
if exist "store\claudeclaw.pid" del "store\claudeclaw.pid" 2>nul

echo  Leallitva.
endlocal
