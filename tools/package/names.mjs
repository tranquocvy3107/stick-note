// The single source of truth for release file names.
// Used by the packaging scripts, the release notes generator and the CI workflows.

export function assetNames(version) {
  return {
    windowsInstaller: `StickNote-${version}-windows-x64-setup.exe`,
    windowsPortable: `StickNote-${version}-windows-x64-portable.zip`,
    linuxDeb: `stick-note_${version}_amd64.deb`,
    linuxAppImage: `StickNote-${version}-linux-x64.AppImage`,
    linuxTarball: `StickNote-${version}-linux-x64.tar.gz`,
    checksums: 'SHA256SUMS.txt',
  };
}
