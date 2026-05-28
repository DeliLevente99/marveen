@echo off
REM Marveen dashboard inditas Windows-on (nativ, WSL nelkul).
REM
REM A dashboard processz on-spawn-eli a main channels session-t
REM (src/web/main-channels-session.ts), tehat itt csak a Node-ot
REM kell felhozni - a channels session a dashboard eletehez van
REM kotve (dashboard kilep -> channels session is leall).

setlocal enableextensions enabledelayedexpansion
cd /d "%~dp0.."

if not exist "dist\index.js" (
    echo [HIBA] dist\index.js nem talalhato. Eloszor futtasd: npm run build
    exit /b 1
)

REM Mar fut? A pidfile-t (store\claudeclaw.pid) atomi O_EXCL-lel irja
REM az acquirePidfileLock - ha letezik es a PID el, ne inditsunk meg
REM egy peldanyt (a Node oldali port-lock amugy is SIGTERM-elne minket).
if exist "store\claudeclaw.pid" (
    set "PID="
    for /f "usebackq tokens=*" %%i in ("store\claudeclaw.pid") do set "PID=%%i"
    if defined PID (
        tasklist /FI "PID eq !PID!" /FO CSV /NH 2>nul | findstr /I "node.exe" >nul
        if not errorlevel 1 (
            echo [INFO] Marveen mar fut (PID !PID!^). Dashboard: http://localhost:3420
            exit /b 0
        )
    )
)

echo Marveen inditasa...
start "Marveen" cmd /k "node dist\index.js"
echo  Dashboard: http://localhost:3420
echo  Leallitas: scripts\stop_server.bat
endlocal
