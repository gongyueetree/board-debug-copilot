$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BaseDir = Join-Path $env:USERPROFILE '.labsight'
$VenvDir = Join-Path $BaseDir 'recamera-webrtc-venv'
$Python = Join-Path $VenvDir 'Scripts\python.exe'
$Pip = Join-Path $VenvDir 'Scripts\pip.exe'
$Bridge = Join-Path $ScriptDir 'recamera_webrtc_bridge.py'
$Req = Join-Path $ScriptDir 'requirements-recamera-bridge.txt'
$TaskName = 'LabSight reCamera WebRTC Bridge'
$LogDir = Join-Path $BaseDir 'logs'

New-Item -ItemType Directory -Force -Path $BaseDir | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (-not (Test-Path $Python)) {
  Write-Host '[LabSight] 创建 Python 环境…'
  $py = Get-Command py -ErrorAction SilentlyContinue
  if ($py) {
    & py -3 -m venv $VenvDir
  } else {
    $pythonCmd = Get-Command python -ErrorAction SilentlyContinue
    if (-not $pythonCmd) { throw '未找到 Python 3。请先安装 Python 3.10+ 并勾选 Add Python to PATH。' }
    & python -m venv $VenvDir
  }
}

Write-Host '[LabSight] 安装/更新 reCamera WebRTC 依赖…'
& $Python -m pip install --upgrade pip
& $Pip install -r $Req

$Action = New-ScheduledTaskAction -Execute $Python -Argument "`"$Bridge`" --host 127.0.0.1 --port 18765"
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal | Out-Null
Start-ScheduledTask -TaskName $TaskName

$ok = $false
for ($i=0; $i -lt 30; $i++) {
  try {
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:18765/health' -TimeoutSec 1
    if ($r.ok) { $ok = $true; break }
  } catch {}
  Start-Sleep -Milliseconds 400
}

if ($ok) {
  Write-Host ''
  Write-Host '✅ LabSight reCamera WebRTC 后台服务已安装并启动。' -ForegroundColor Green
  Write-Host '以后登录 Windows 会自动运行，不需要再手工启动 Python。'
  Write-Host '健康检查：http://127.0.0.1:18765/health'
} else {
  Write-Host ''
  Write-Host '⚠️ 服务已经注册，但健康检查没有通过。' -ForegroundColor Yellow
  Write-Host '请确认 Windows 防火墙没有阻止 Python，并重新运行安装器。'
}

Read-Host '按回车关闭'
