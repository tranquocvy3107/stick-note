# Tao shortcut "Stick Note" (co icon rieng) de mo app bang mot cu bam dup.
#
#   powershell -ExecutionPolicy Bypass -File tools\create-shortcut.ps1              # ra Desktop
#   powershell -ExecutionPolicy Bypass -File tools\create-shortcut.ps1 -StartMenu   # them vao menu Start
#
# (Chu thich trong file nay viet khong dau vi PowerShell 5 doc file khong co BOM theo bang ma cua may.)

param(
  [switch]$StartMenu,
  [string]$Name = 'Stick Note'
)

$root = Split-Path -Parent $PSScriptRoot
$shell = New-Object -ComObject WScript.Shell

function New-AppShortcut([string]$folder) {
  $path = Join-Path $folder "$Name.lnk"
  $link = $shell.CreateShortcut($path)
  $link.TargetPath = Join-Path $root 'start.bat'
  $link.WorkingDirectory = $root
  $link.IconLocation = (Join-Path $root 'public\icons\app.ico') + ',0'
  $link.WindowStyle = 7   # chay thu nho de cua so console khong nhay len
  $link.Description = 'Stick Note - whiteboard giay nho ca nhan'
  $link.Save()
  return $path
}

New-AppShortcut ([Environment]::GetFolderPath('Desktop'))
if ($StartMenu) { New-AppShortcut ([Environment]::GetFolderPath('Programs')) }
