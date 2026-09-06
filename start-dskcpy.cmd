@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 exit /b 1
where node.exe >nul 2>&1
if errorlevel 1 (
  echo dskcpy needs Node.js 22.12 or later on PATH.
  echo Install Node.js, then reopen this launcher. See README.md for setup.
  pause
  popd
  exit /b 1
)
node.exe "%~dp0gui\scripts\launch.mjs" %*
set "dskcpyExit=%errorlevel%"
if not "%dskcpyExit%"=="0" pause
popd
exit /b %dskcpyExit%
