@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo 首次运行，正在安装依赖...
  call npm install
  if errorlevel 1 goto :fail
)

echo 正在构建...
call npm run build
if errorlevel 1 goto :fail

echo 启动中...
call npm start
exit /b 0

:fail
echo.
echo 启动失败，请查看上面的报错信息。
pause
exit /b 1