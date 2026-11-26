@echo off
setlocal enabledelayedexpansion

rem Vigil Windows launcher (#263, decision 0008).
rem Checks Docker Desktop, starts compose services, and opens the browser.

cd /d "%~dp0\.."

rem 1. Check if Docker is installed and in PATH
where docker >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo.
    echo ============================================================
    echo Hata: Docker yuklu degil veya PATH icinde bulunamadi.
    echo Error: Docker is not installed or not in PATH.
    echo.
    echo Lutfen Windows icin Docker Desktop uygulamasini kurun:
    echo Please install Docker Desktop for Windows:
    echo   https://docs.docker.com/desktop/setup/install/windows-install/
    echo ============================================================
    echo.
    if "%~1"=="" pause
    exit /b 1
)

rem 2. Check if Docker daemon / Docker Desktop is running
docker info >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo.
    echo ============================================================
    echo Hata: Docker Desktop calismiyor.
    echo Error: Docker Desktop is not running.
    echo.
    echo Lutfen Docker Desktop uygulamasini baslatin ve tekrar deneyin.
    echo Please start Docker Desktop and try again.
    echo ============================================================
    echo.
    if "%~1"=="" pause
    exit /b 1
)

rem 3. Check if Docker Compose plugin is available
docker compose version >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo.
    echo ============================================================
    echo Hata: 'docker compose' eklentisi bulunamadi.
    echo Error: 'docker compose' plugin not found.
    echo.
    echo Lutfen Docker Desktop'i guncelleyin.
    echo Please update Docker Desktop.
    echo ============================================================
    echo.
    if "%~1"=="" pause
    exit /b 1
)

rem 4. Start compose services
echo.
echo Vigil baslatiliyor / Starting Vigil...
docker compose up -d
if %ERRORLEVEL% neq 0 (
    echo.
    echo Hata: 'docker compose up' basarisiz oldu.
    echo Error: 'docker compose up' failed.
    echo.
    if "%~1"=="" pause
    exit /b 1
)

rem 5. Wait for web service to be ready
echo Servislerin hazir olmasi bekleniyor / Waiting for Vigil to be ready...
powershell -NoProfile -Command ^
  "$ready = $false; for ($i=0; $i -lt 30; $i++) { try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3000' -UseBasicParsing -TimeoutSec 1; if ($r.StatusCode -eq 200) { $ready = $true; break } } catch {}; Start-Sleep -Seconds 1 }; if ($ready) { exit 0 } else { exit 1 }" >nul 2>nul

rem 6. Open browser
start http://127.0.0.1:3000

echo.
echo ============================================================
echo Vigil basariyla baslatildi / Vigil is running:
echo   http://127.0.0.1:3000
echo.
echo Durdurmak icin / To stop Vigil:
echo   docker compose down
echo ============================================================
echo.
if "%~1"=="" (
    echo Pencereyi kapatmak icin bir tusa basin / Press any key to close...
    pause >nul
)
exit /b 0
