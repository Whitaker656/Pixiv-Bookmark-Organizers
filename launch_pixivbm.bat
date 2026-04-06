@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 launch_pixivbm.py
  goto :end
)

where python >nul 2>nul
if %errorlevel%==0 (
  python launch_pixivbm.py
  goto :end
)

echo Python executable was not found.
pause

:end
endlocal
