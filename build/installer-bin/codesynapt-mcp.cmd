@echo off
REM CodeSynapt MCP server shim (used by `claude mcp add codesynapt codesynapt-mcp`).
setlocal
set "_CS_ROOT=%~dp0.."
set "_CS_MCP=%_CS_ROOT%\resources\app\packages\core\bin\codesynapt-mcp.cjs"
set "_CS_BUNDLED_NODE=%_CS_ROOT%\runtime\node.exe"

if exist "%_CS_BUNDLED_NODE%" (
  "%_CS_BUNDLED_NODE%" "%_CS_MCP%" %*
  exit /b %errorlevel%
)

where node >nul 2>&1
if %errorlevel% equ 0 (
  node "%_CS_MCP%" %*
  exit /b %errorlevel%
)

echo Error: Node.js not found. >&2
echo   Reinstall CodeSynapt and check "Bundled Node.js" during setup, >&2
echo   or install Node.js 20+ from https://nodejs.org and ensure it is on PATH. >&2
exit /b 1
