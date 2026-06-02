@echo off
REM CodeSynapt CLI shim (installed to %LOCALAPPDATA%\Programs\CodeSynapt\bin\)
REM Priority: bundled node > system PATH node > error.
setlocal
set "_CS_ROOT=%~dp0.."
set "_CS_CLI=%_CS_ROOT%\resources\app\packages\core\bin\codesynapt.cjs"
set "_CS_BUNDLED_NODE=%_CS_ROOT%\runtime\node.exe"

if exist "%_CS_BUNDLED_NODE%" (
  "%_CS_BUNDLED_NODE%" "%_CS_CLI%" %*
  exit /b %errorlevel%
)

where node >nul 2>&1
if %errorlevel% equ 0 (
  node "%_CS_CLI%" %*
  exit /b %errorlevel%
)

echo Error: Node.js not found.
echo   Reinstall CodeSynapt and check "Bundled Node.js" during setup,
echo   or install Node.js 20+ from https://nodejs.org and ensure it is on PATH.
exit /b 1
