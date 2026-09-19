@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo   ==================================================
echo    把最新版本发布到网页
echo   ==================================================
echo.
echo   第一次运行：会弹出 GitHub 登录窗口，登录一次就行。
echo   以后每次改完，双击这个文件就可以更新网页。
echo.

git add -A
git -c user.email=dev@local -c user.name=dev commit -m "更新" >nul 2>&1

git push origin main --force
if errorlevel 1 goto failed

echo.
echo   --------------------------------------------------
echo    成功了！
echo.
echo    等 1 分钟，打开这个网址就能看到新版本：
echo    https://xiaoyang2708.github.io/jihuamoni/
echo.
echo    手机上打开同一个网址也能用（朋友也是打开这个）。
echo   --------------------------------------------------
goto end

:failed
echo.
echo   --------------------------------------------------
echo    没有成功。最常见的两个原因：
echo.
echo    1. 登录没走完 —— 再双击一次这个文件，
echo       把弹出的 GitHub 登录窗口填完。
echo.
echo    2. 没装 Git —— 那就要先装 Git 才能用这个方式，
echo       或者告诉我，我教你在网页上直接上传。
echo   --------------------------------------------------

:end
echo.
pause
