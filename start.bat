@echo off
rem ===========================================================================
rem  Resume Tailor - start both servers
rem
rem  Double-click this file (or run `start.bat` from a prompt) and it will:
rem    1. check Python and Node are installed
rem    2. create backend\.venv and install requirements.txt the first time
rem    3. run `npm install` the first time
rem    4. open one window for the API and one for the web app
rem    5. open http://localhost:5173 in your browser
rem
rem  Each server gets its own window so you can read its log and stop it with
rem  Ctrl+C. Closing a window stops that server; the other keeps running.
rem
rem  This script re-runs itself with --backend / --frontend to fill those two
rem  windows, which is why those switches appear below.
rem ===========================================================================

setlocal EnableExtensions

rem %~dp0 is this file's own folder, so the script works whatever the current
rem directory is - including the C:\Windows\System32 a shortcut can hand it.
cd /d "%~dp0"

set "ROOT=%CD%"
set "BACKEND=%ROOT%\backend"
set "FRONTEND=%ROOT%\frontend"
set "VENV=%BACKEND%\.venv"
set "VENV_PY=%VENV%\Scripts\python.exe"
set "DEPS_MARKER=%VENV%\.requirements-installed.txt"
set "API_HOST=127.0.0.1"
set "API_PORT=8000"
set "WEB_PORT=5173"

rem --- the two child roles ---------------------------------------------------
if /i "%~1"=="--backend"  goto :role_backend
if /i "%~1"=="--frontend" goto :role_frontend

rem ===========================================================================
rem  Parent: check everything, then open the two windows.
rem ===========================================================================

title Resume Tailor - launcher
echo.
echo   Resume Tailor
echo   %ROOT%
echo.

rem --- sanity: is this actually the project folder? ---------------------------
if not exist "%BACKEND%\app\main.py" goto :wrong_folder
if not exist "%FRONTEND%\package.json" goto :wrong_folder

rem --- Python ----------------------------------------------------------------
rem Prefer the `py` launcher: a bare `python` on Windows is often the Microsoft
rem Store stub, which appears to run and then does nothing.
set "PY="
where py >nul 2>&1
if not errorlevel 1 set "PY=py -3"
if not defined PY (
  where python >nul 2>&1
  if not errorlevel 1 set "PY=python"
)
if not defined PY (
  echo   [X] Python was not found on PATH.
  echo       Install Python 3.10 or newer from https://www.python.org/downloads/
  echo       and tick "Add python.exe to PATH" in the installer.
  goto :fail
)

rem --- Node ------------------------------------------------------------------
where npm >nul 2>&1
if errorlevel 1 (
  echo   [X] npm was not found on PATH.
  echo       Install Node.js 18 or newer from https://nodejs.org/
  goto :fail
)

rem --- 1/3  virtual environment ----------------------------------------------
if exist "%VENV_PY%" goto :venv_ready
echo   [1/3] Creating backend\.venv ...
%PY% -m venv "%VENV%"
if errorlevel 1 (
  echo   [X] Could not create the virtual environment.
  goto :fail
)
rem A brand new venv has nothing installed, whatever an old marker says.
del "%DEPS_MARKER%" >nul 2>&1
goto :venv_checked

:venv_ready
echo   [1/3] backend\.venv is there.
:venv_checked

rem --- 2/3  Python packages --------------------------------------------------
rem The marker is a copy of the requirements.txt that was last installed, so a
rem dependency added to requirements.txt later triggers a reinstall - which
rem importing one package to test would not catch.
if not exist "%DEPS_MARKER%" goto :deps_install
fc /b "%BACKEND%\requirements.txt" "%DEPS_MARKER%" >nul 2>&1
if errorlevel 1 goto :deps_install
echo   [2/3] Python packages are up to date.
goto :deps_done

:deps_install
echo   [2/3] Installing Python packages ^(first run takes a minute^) ...
"%VENV_PY%" -m pip install --upgrade pip --quiet
"%VENV_PY%" -m pip install -r "%BACKEND%\requirements.txt"
if errorlevel 1 (
  echo   [X] pip install failed. Scroll up for the reason.
  goto :fail
)
copy /y "%BACKEND%\requirements.txt" "%DEPS_MARKER%" >nul
:deps_done

rem --- 3/3  npm packages -----------------------------------------------------
if exist "%FRONTEND%\node_modules" (
  echo   [3/3] node_modules is there.
  goto :npm_done
)
echo   [3/3] Installing npm packages ^(first run takes a minute^) ...
pushd "%FRONTEND%"
call npm install
if errorlevel 1 (
  popd
  echo   [X] npm install failed. Scroll up for the reason.
  goto :fail
)
popd
:npm_done

rem --- .env ------------------------------------------------------------------
rem Not fatal: every page works, but Generate and Humanize will report that no
rem model is configured.
if not exist "%BACKEND%\.env" (
  echo.
  echo   [!] backend\.env is missing, so no model is configured.
  echo       Copy backend\.env.example to backend\.env and fill in LLM_BASE_URL,
  echo       CLAUDE_API_KEY and CLAUDE_MODEL. Everything else still works.
)

rem --- ports -----------------------------------------------------------------
rem Something already listening is almost always this script started twice. A
rem second uvicorn on a busy port exits immediately; a second Vite quietly moves
rem to 5174 and then talks to nothing. Leave the running one alone instead.
set "SKIP_API="
set "SKIP_WEB="
netstat -ano -p tcp | find "LISTENING" | find ":%API_PORT% " >nul 2>&1
if not errorlevel 1 set "SKIP_API=1"
netstat -ano -p tcp | find "LISTENING" | find ":%WEB_PORT% " >nul 2>&1
if not errorlevel 1 set "SKIP_WEB=1"

echo.
if defined SKIP_API (
  echo   - API      already listening on port %API_PORT%, leaving it alone
) else (
  echo   - API      http://%API_HOST%:%API_PORT%   ^(docs at /docs^)
  start "Resume Tailor - API" cmd /k call "%~f0" --backend
)

if defined SKIP_WEB (
  echo   - Web app  already listening on port %WEB_PORT%, leaving it alone
) else (
  echo   - Web app  http://localhost:%WEB_PORT%
  start "Resume Tailor - Web" cmd /k call "%~f0" --frontend
)

rem Give Vite a moment to bind the port before the browser asks for it.
timeout /t 6 /nobreak >nul
start "" "http://localhost:%WEB_PORT%"

echo.
echo   Both windows are open. Press Ctrl+C in a window, or close it, to stop
echo   that server. This launcher window can be closed now.
echo.
timeout /t 5 /nobreak >nul
endlocal
exit /b 0

:wrong_folder
echo   [X] backend\app\main.py or frontend\package.json was not found.
echo       Keep start.bat in the resume-tailor folder, beside backend\ and frontend\.
goto :fail

:fail
echo.
echo   Nothing was started.
echo.
pause
endlocal
exit /b 1

rem ===========================================================================
rem  Child roles - one per window
rem ===========================================================================

:role_backend
title Resume Tailor - API
rem cd into backend first: DATABASE_FILE defaults to the relative path
rem data/resume-tailor.db, so uvicorn started from anywhere else would create a
rem second, empty database instead of opening the real one.
cd /d "%BACKEND%"
echo Starting the API on http://%API_HOST%:%API_PORT%   (Ctrl+C to stop)
echo.
"%VENV_PY%" -m uvicorn app.main:app --host %API_HOST% --port %API_PORT% --reload
echo.
echo API stopped.
pause
endlocal
exit /b 0

:role_frontend
title Resume Tailor - Web
cd /d "%FRONTEND%"
echo Starting the web app on http://localhost:%WEB_PORT%   (Ctrl+C to stop)
echo.
call npm run dev -- --port %WEB_PORT% --strictPort
echo.
echo Web app stopped.
pause
endlocal
exit /b 0
