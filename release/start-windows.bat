@echo off
rem Starts a local web server for this folder and opens the piece in a browser.
rem Double-click to run. Close this window to stop the server.

cd /d "%~dp0"

rem Use 8000 unless another server (e.g. an earlier launch that is still
rem running) already has it, in which case take the next free port. This check
rem matters on Windows: Python can silently share a port that is in use.
set PORT=8000
:findport
netstat -an | findstr /c:":%PORT% " >nul
if errorlevel 1 goto portfound
set /a PORT+=1
if %PORT% GTR 8020 goto noport
goto findport

:noport
echo Ports 8000-8020 are all in use. Close other servers and try again.
pause
goto :eof

:portfound
echo Serving on http://localhost:%PORT%/ - close this window to stop.

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
