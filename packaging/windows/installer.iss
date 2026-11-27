; Stick Note installer for Windows (Inno Setup 6.3 or newer, https://jrsoftware.org/isinfo.php).
;
; It is compiled by tools/package/build-windows.mjs, which passes these values on the command line:
;   /DAppVersion=1.1.0              version of the app (from package.json)
;   /DNumericVersion=1.1.0.0        the same as four numbers, for the Windows version resource
;   /DSourceDir=<folder>            the finished program files (Stick Note.exe, runtime\, app\, ...)
;   /DOutputDir=<folder>            where the setup program is written (dist\)
;   /DOutputBaseFilename=<name>     file name of the setup program without ".exe" (from tools/package/names.mjs)
;   /DRepoRoot=<folder>             the repository root (for the icon)
;   /DCopyright=<text>              copyright line (from LICENSE)
;   /DAppUrl=<url>                  project home page

#ifndef AppVersion
  #error Pass the version with /DAppVersion=x.y.z (tools/package/build-windows.mjs does this).
#endif
#ifndef NumericVersion
  #error Pass /DNumericVersion=x.y.z.0
#endif
#ifndef SourceDir
  #error Pass /DSourceDir=<folder with the program files>
#endif
#ifndef OutputDir
  #error Pass /DOutputDir=<folder for the setup program>
#endif
#ifndef OutputBaseFilename
  #error Pass /DOutputBaseFilename=<setup file name without .exe>
#endif
#ifndef RepoRoot
  #error Pass /DRepoRoot=<repository folder>
#endif
#ifndef Copyright
  #define Copyright ""
#endif
#ifndef AppUrl
  #define AppUrl "https://github.com/vytk712025main-eng/stick-note"
#endif

#define AppName "Stick Note"
#define AppExe "Stick Note.exe"

[Setup]
; Never change AppId. Windows uses it to recognise an earlier installation, which is how an upgrade
; replaces the old files and how "Apps & features" finds the uninstaller.
AppId={{2EDA025B-3EC9-46ED-8EAA-141C4C1AC42D}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppName}
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}/issues
AppUpdatesURL={#AppUrl}/releases
AppCopyright={#Copyright}
VersionInfoVersion={#NumericVersion}
VersionInfoProductName={#AppName}
VersionInfoDescription={#AppName} Setup

; Per-user install: no administrator prompt. {autopf} then means %LOCALAPPDATA%\Programs.
PrivilegesRequired=lowest
DefaultDirName={autopf}\{#AppName}
DisableProgramGroupPage=yes
; Fewest possible clicks: Install, then Finish. The folder is fixed; the notes are stored elsewhere anyway.
DisableWelcomePage=yes
DisableDirPage=yes
DisableReadyPage=yes
WizardStyle=modern
ShowLanguageDialog=no

; 64-bit only (the bundled Node.js is the x64 build).
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0

Compression=lzma2/ultra64
SolidCompression=yes

SetupIconFile={#RepoRoot}\public\icons\app.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
SetupMutex=StickNoteSetupMutex

OutputDir={#OutputDir}
OutputBaseFilename={#OutputBaseFilename}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
; Checked by default.
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; Start from clean program folders so a file that no longer exists in this version does not linger.
; Safe because the notes are NOT stored here: they live in %APPDATA%\Stick Note, which setup never touches.
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\runtime"

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; Comment: "A personal whiteboard of sticky notes"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Comment: "A personal whiteboard of sticky notes"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#StringChange(AppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; The uninstaller removes the files it installed. These two lines only clear anything the app may have
; added inside its own folders. The data folder (%APPDATA%\Stick Note) is deliberately never touched.
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\runtime"

[Code]
// Ask a running Stick Note to quit, so its files are not locked while they are replaced or removed.
// Any failure is ignored on purpose: the usual reason is simply that Stick Note is not running.
procedure StopRunningServer(const InstallDir: String);
var
  ServerExe, ScriptFile: String;
  ResultCode: Integer;
begin
  ServerExe := InstallDir + '\runtime\stick-note-server.exe';
  ScriptFile := InstallDir + '\app\server.js';
  if FileExists(ServerExe) and FileExists(ScriptFile) then
    Exec(ServerExe, '"' + ScriptFile + '" --stop', InstallDir, SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopRunningServer(WizardDirValue);
  Result := '';
end;

// The "ready to install" page is switched off (see [Setup]), so the tasks page is the last one before
// files are copied. Label its button "Install" so the person knows that this click starts the installation.
procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpSelectTasks then
    WizardForm.NextButton.Caption := SetupMessage(msgButtonInstall);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    StopRunningServer(ExpandConstant('{app}'));
end;
