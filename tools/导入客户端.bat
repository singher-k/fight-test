@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Import Config - config-templates\json to assets

call "%~dp0_find-python.bat"
if errorlevel 1 goto :no_python

rem Write to client resources.  Compare only, no write:  import-config.bat --check
echo.
echo Using: %PYEXE% %PYARG%
"%PYEXE%" %PYARG% "%~dp0import-config.py" %*
set "RC=%errorlevel%"

echo.
if not "%RC%"=="0" echo [FAILED] See the errors above. Client config untouched.
echo.
pause
exit /b %RC%

:no_python
echo.
echo [ERROR] No Python 3 found (python / py -3 / python3 all failed).
echo         Install Python 3.8+ from https://www.python.org/downloads/windows/
echo         and tick "Add python.exe to PATH" during setup.
echo.
pause
exit /b 1
