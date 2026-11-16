# Creates the training environment in .venv (Python 3.12 + PyTorch with CUDA) using uv.
# Run from the project root:   powershell -ExecutionPolicy Bypass -File training\setup_env.ps1
# Add -Cpu to install the CPU-only build (fallback when CUDA is not available).
# Everything (Python, package cache, temp files) stays inside the project folder so drive C: is not used.
# No system settings are changed. Requires only uv (https://docs.astral.sh/uv/).
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less scripts as ANSI and breaks on Cyrillic.
param([switch]$Cpu)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$cache = Join-Path $root '.cache'
New-Item -ItemType Directory -Force (Join-Path $cache 'uv'), (Join-Path $cache 'python'), (Join-Path $cache 'tmp'), (Join-Path $cache 'torch') | Out-Null
$env:UV_CACHE_DIR = Join-Path $cache 'uv'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $cache 'python'
$env:TEMP = Join-Path $cache 'tmp'
$env:TMP = $env:TEMP
$env:UV_LINK_MODE = 'hardlink'

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw 'uv not found. Install it: https://docs.astral.sh/uv/getting-started/installation/' }

if (-not (Test-Path '.venv\Scripts\python.exe')) {
  uv venv .venv --python 3.12
  if ($LASTEXITCODE -ne 0) { throw 'Failed to create .venv' }
}

$index = if ($Cpu) { 'https://download.pytorch.org/whl/cpu' } else { 'https://download.pytorch.org/whl/cu126' }
uv pip install --python .venv\Scripts\python.exe torch torchvision --index-url $index
if ($LASTEXITCODE -ne 0) { throw 'Failed to install PyTorch' }
uv pip install --python .venv\Scripts\python.exe -r training\requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'Failed to install requirements' }

.venv\Scripts\python.exe -c "import torch, torchvision; print('torch', torch.__version__, '| torchvision', torchvision.__version__, '| CUDA:', torch.cuda.is_available(), '|', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU')"
