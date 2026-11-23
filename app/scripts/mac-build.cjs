const { execFileSync } = require('node:child_process')
const { mkdirSync, readdirSync, lstatSync, openSync, readSync, closeSync, rmSync } = require('node:fs')
const { join } = require('node:path')

if (process.platform !== 'darwin') process.exit(0)

const app = join(__dirname, '..')
const bundle = join(app, 'dist', 'mac-arm64', 'Twinmap.app')
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' })

// A Mach-O file outside the places `codesign --deep` covers, e.g. koffi's .node in app.asar.unpacked.
const MACHO = new Set(['cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca'])
function looseBinaries(dir, found = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name), stat = lstatSync(path)
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) { if (!/\.(app|framework)$/.test(name)) looseBinaries(path, found); continue }
    if (stat.size < 4) continue
    const fd = openSync(path, 'r'), head = Buffer.alloc(4)
    readSync(fd, head, 0, 4, 0); closeSync(fd)
    if (MACHO.has(head.toString('hex'))) found.push(path)
  }
  return found
}

if (process.argv[2] === 'sign') {
  // TWINMAP_MAC_IDENTITY: a Developer ID ("Developer ID Application: …") keeps macOS permissions such as
  // Screen Recording across rebuilds; without it the build is signed ad hoc, which this Mac alone accepts
  // and which loses those permissions with every rebuild.
  const identity = process.env.TWINMAP_MAC_IDENTITY || '-'
  if (identity === '-') {
    run('codesign', ['--force', '--deep', '--sign', '-', bundle])
  } else {
    // Notarization needs the hardened runtime and a secure timestamp on every binary, inside out.
    const flags = ['--force', '--options', 'runtime', '--timestamp', '--entitlements', join(app, 'build', 'entitlements.mac.plist'), '--sign', identity]
    for (const file of looseBinaries(join(bundle, 'Contents', 'Resources'))) run('codesign', [...flags, file])
    run('codesign', [...flags, '--deep', bundle])
  }
  run('codesign', ['--verify', '--deep', '--strict', bundle])
  // TWINMAP_MAC_NOTARY_PROFILE: a notarytool keychain profile (xcrun notarytool store-credentials). The secret
  // stays in the keychain; this only names it. Notarized and stapled, the app opens on any Mac without a warning.
  const profile = process.env.TWINMAP_MAC_NOTARY_PROFILE
  if (profile && identity !== '-') {
    const zip = join(app, 'dist', 'Twinmap-notarize.zip')
    rmSync(zip, { force: true })
    run('ditto', ['-c', '-k', '--keepParent', bundle, zip])
    run('xcrun', ['notarytool', 'submit', zip, '--keychain-profile', profile, '--wait', '--timeout', '30m'])
    run('xcrun', ['stapler', 'staple', bundle])
    run('spctl', ['--assess', '--type', 'execute', '-vv', bundle])
    rmSync(zip, { force: true })
  }
} else {
  const output = join(app, 'dist-native')
  mkdirSync(output, { recursive: true })
  execFileSync('swiftc', [
    '-O', '-target', 'arm64-apple-macos14.0', '-parse-as-library',
    join(app, 'native', 'capture-mac.swift'), '-o', join(output, 'twinmap-capture'),
  ], { stdio: 'inherit' })
}
