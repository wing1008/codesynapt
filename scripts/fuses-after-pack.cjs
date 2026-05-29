// Electron Fuses — flip security-relevant flags off in the packaged binary.
// Called via package.json `build.afterPack` hook by electron-builder.
//
// Why: a signed Electron binary by default lets `ELECTRON_RUN_AS_NODE=1`
// run arbitrary Node code. Closing that fuse removes that RCE vector.
//
// docs: https://www.electronjs.org/docs/latest/tutorial/fuses
const path = require('path')
const fs = require('fs')

exports.default = async function fusesAfterPack(context) {
  // @electron/fuses is ESM-only, so dynamic import from this CJS hook.
  const { flipFuses, FuseVersion, FuseV1Options } = await import('@electron/fuses')
  const exeName = context.packager.platform.nodeName === 'darwin'
    ? `${context.packager.appInfo.productFilename}.app`
    : `${context.packager.appInfo.productFilename}.exe`
  const exePath = path.join(context.appOutDir, exeName)
  if (!fs.existsSync(exePath)) {
    console.warn(`[fuses] target not found: ${exePath} — skipping`)
    return
  }
  await flipFuses(exePath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: false,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  })
  console.log(`[fuses] applied to ${exePath}`)
}
