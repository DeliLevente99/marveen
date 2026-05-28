@echo off
REM Marveen build Windows-on (tsc -> dist/).
REM
REM A start_server.bat csak akkor indul el, ha dist\index.js letezik,
REM tehat minden src/ valtozas utan futtatni kell ezt mielott
REM scripts\start_server.bat-tal feleleszted a dashboardot.

setlocal enableextensions
cd /d "%~dp0.."

if not exist "package.json" (
    echo [HIBA] package.json nem talalhato itt: %CD%
    exit /b 1
)

echo Marveen build (npm run build)...
call npm run build
if errorlevel 1 (
    echo [HIBA] Build sikertelen.
    exit /b 1
)

if not exist "dist\index.js" (
    echo [HIBA] dist\index.js nem jott letre - tsc hiba?
    exit /b 1
)

echo  Kesz: dist\index.js
echo  Inditas: scripts\start_server.bat
endlocal
