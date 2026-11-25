@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Export Config - config-templates\*.xlsx

call "%~dp0..\tools\_find-python.bat"
if errorlevel 1 goto :no_python

rem ---- dependency check ----
"%PYEXE%" %PYARG% -c "import openpyxl" >nul 2>&1
if not errorlevel 1 goto :run

echo [Setup] Installing openpyxl ...
rem Some pip builds die on chcp 65001 ("unknown encoding: cp65001").
rem Drop to the system codepage while installing, then switch back.
chcp 936 >nul
"%PYEXE%" %PYARG% -m pip install openpyxl
if not errorlevel 1 goto :pip_ok
chcp 65001 >nul
echo.
echo [ERROR] Failed to install openpyxl. Run it manually:
echo             "%PYEXE%" %PYARG% -m pip install openpyxl
echo.
pause
exit /b 1
:pip_ok
chcp 65001 >nul

:run
rem Double click = export.  Preview only, no write:  export-config.bat --preview
rem --preview is a real option in export-config.py, so extra args like
rem "--only hit" survive regardless of where it sits.
set "ARGS=--write %*"
if /i "%~1"=="--preview" set "ARGS=%*"

echo.
echo Using: %PYEXE% %PYARG%
"%PYEXE%" %PYARG% "%~dp0export-config.py" %ARGS%
set "RC=%errorlevel%"

echo.
if not "%RC%"=="0" echo [FAILED] See the errors above. No JSON was written.
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
