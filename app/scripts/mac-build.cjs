const { execFileSync } = require('node:child_process')
const { mkdirSync } = require('node:fs')
const { join } = require('node:path')

if (process.platform !== 'darwin') process.exit(0)

const app = join(__dirname, '..')
if (process.argv[2] === 'sign') {
  // TWINMAP_MAC_IDENTITY: a Developer ID ("Developer ID Application: …") keeps macOS permissions such as
  // Screen Recording across rebuilds; without it the build is signed ad hoc, which this Mac alone accepts
  // and which loses those permissions with every rebuild.
  const identity = process.env.TWINMAP_MAC_IDENTITY || '-'
  execFileSync('codesign', ['--force', '--deep', '--sign', identity, join(app, 'dist', 'mac-arm64', 'Twinmap.app')], { stdio: 'inherit' })
} else {
  const output = join(app, 'dist-native')
  mkdirSync(output, { recursive: true })
  execFileSync('swiftc', [
    '-O', '-target', 'arm64-apple-macos14.0', '-parse-as-library',
    join(app, 'native', 'capture-mac.swift'), '-o', join(output, 'twinmap-capture'),
  ], { stdio: 'inherit' })
}
