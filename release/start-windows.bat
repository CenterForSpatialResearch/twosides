@echo off
rem Starts a local web server for this folder and opens the piece in a browser.
rem Double-click to run. Close this window to stop the server.

cd /d "%~dp0"
set PORT=8000

rem "py" is the Python launcher. Checked first because a bare "python" can be
rem the Microsoft Store stub, which opens the Store instead of running.
py -3 -c "print(1)" >nul 2>&1
if %errorlevel%==0 (
  start "" http://localhost:%PORT%/
  py -3 -m http.server %PORT%
  goto :eof
)

python -c "print(1)" >nul 2>&1
if %errorlevel%==0 (
  start "" http://localhost:%PORT%/
  python -m http.server %PORT%
  goto :eof
)

where npx >nul 2>&1
if %errorlevel%==0 (
  start "" http://localhost:%PORT%/
  call npx --yes serve -l %PORT% .
  goto :eof
)

echo This launcher needs Python 3 or Node.js installed.
echo Install one (https://www.python.org or https://nodejs.org) and run this again.
pause
