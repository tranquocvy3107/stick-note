# Create a "Stick Note" shortcut (with its own icon) so the app opens with a double-click.
# Only needed when running from a source checkout; the installers create their own shortcuts.
#
#   powershell -ExecutionPolicy Bypass -File tools\create-shortcut.ps1              # on the Desktop
#   powershell -ExecutionPolicy Bypass -File tools\create-shortcut.ps1 -StartMenu   # also in the Start menu
#
# (This file is plain ASCII on purpose: Windows PowerShell 5 reads files without a BOM in the machine's code page.)

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
  $link.WindowStyle = 7   # run minimised so the console window does not flash
  $link.Description = 'Stick Note - a personal whiteboard of sticky notes'
  $link.Save()
  return $path
}

New-AppShortcut ([Environment]::GetFolderPath('Desktop'))
if ($StartMenu) { New-AppShortcut ([Environment]::GetFolderPath('Programs')) }
