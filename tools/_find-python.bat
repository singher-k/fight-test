@echo off
rem ==========================================================================
rem  Find a usable Python 3 interpreter. Called by the other .bat files.
rem
rem    call "path\_find-python.bat"
rem    ok    -> PYEXE / PYARG exported, errorlevel 0
rem    fail  -> errorlevel 2, caller handles the message and pause
rem
rem  Why version check: the first "python" on PATH is very often Python 2.7
rem  (C:\Python27). Python 2 passes a bare "import sys" check, then its pip
rem  dies under chcp 65001 with "LookupError: unknown encoding: cp65001".
rem  Only 3.x is accepted here.
rem
rem  No setlocal on purpose: it would discard PYEXE before the caller sees it.
rem  ASCII only: non-ASCII in a .bat gets decoded with the wrong codepage and
rem  breaks the command line (seen in practice: "schema" turned into "ma").
rem ==========================================================================

set "PYEXE="
set "PYARG="

rem ---- 1) python on PATH, must really be 3.x ----
python -c "import sys;sys.exit(0 if sys.version_info[0]==3 else 1)" >nul 2>&1
if not errorlevel 1 (
    set "PYEXE=python"
    goto :fp_done
)

rem ---- 2) py launcher, pinned to -3 ----
py -3 -c "import sys;sys.exit(0 if sys.version_info[0]==3 else 1)" >nul 2>&1
if not errorlevel 1 (
    set "PYEXE=py"
    set "PYARG=-3"
    goto :fp_done
)

rem ---- 3) python3 ----
python3 -c "import sys;sys.exit(0 if sys.version_info[0]==3 else 1)" >nul 2>&1
if not errorlevel 1 (
    set "PYEXE=python3"
    goto :fp_done
)

rem ---- 4) common install roots, including bundled interpreters ----
rem Covers: per-user install, all-users install, and the Python shipped with
rem this toolchain (so no manual install is needed on machines that have it).
for /d %%P in ("%LOCALAPPDATA%\Programs\Python\Python3*" "C:\Program Files\Python3*" "%USERPROFILE%\.workbuddy\binaries\python\versions\*") do (
    if not defined PYEXE if exist "%%~P\python.exe" (
        "%%~P\python.exe" -c "import sys;sys.exit(0 if sys.version_info[0]==3 else 1)" >nul 2>&1
        if not errorlevel 1 set "PYEXE=%%~P\python.exe"
    )
)

:fp_done
if not defined PYEXE exit /b 2
exit /b 0
