@echo off
REM kongcode platform dispatcher (Windows cmd.exe).
REM
REM Invoked by Claude Code's plugin loader via .mcp.json on Windows.
REM Detects arch and execs the matching SEA binary. The whole point is
REM to make the plugin install zero-Node-prereq: the SEA binary contains
REM the Node runtime, so once Claude Code copies the plugin files in,
REM no further user setup is needed.

setlocal

REM PROCESSOR_ARCHITECTURE on x64 hosts is "AMD64"; on arm64 hosts it's "ARM64".
REM Under WOW64 (32-bit cmd on 64-bit host), check PROCESSOR_ARCHITEW6432 too.
set "ARCH="
if /I "%PROCESSOR_ARCHITECTURE%"=="AMD64" set "ARCH=x64"
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"
if /I "%PROCESSOR_ARCHITEW6432%"=="AMD64" set "ARCH=x64"
if /I "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "ARCH=arm64"

if "%ARCH%"=="" (
  echo kongcode: unsupported arch %PROCESSOR_ARCHITECTURE% -- supported: x64, arm64. File at https://github.com/42U/kongcode/issues 1>&2
  exit /b 1
)

set "BIN=%~dp0kongcode-win32-%ARCH%.exe"
if exist "%BIN%" (
  REM Preferred: SEA binary is present (0.7.0+ release). Zero-Node-prereq.
  "%BIN%" %*
  exit /b %ERRORLEVEL%
)

REM Fallback: invoke the unbundled JS via Node. 0.6.x install with no CI
REM artifacts. Requires Node on PATH.
where node >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  node "%~dp0..\dist\mcp-server.js" %*
  exit /b %ERRORLEVEL%
)

echo kongcode: no usable runtime found. Tried SEA binary at %BIN% (not present) and 'node' (not on PATH). Install Node.js (https://nodejs.org) and restart Claude Code, or wait for a 0.7.0 release artifact for your platform. 1>&2
exit /b 1
