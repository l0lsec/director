#!/usr/bin/env node
// One command: bundle sidecars, build and stage the app, package Director.app with electron-builder.
//
// Signing: with a "Developer ID Application" certificate in the keychain (or DIRECTOR_SIGN_IDENTITY set to one),
// the app is signed with the hardened runtime so it runs on other Macs. If a notarytool keychain profile named
// "director-notary" exists (or DIRECTOR_NOTARY_PROFILE names one), the app is also notarized and stapled.
// Create the profile once with: xcrun notarytool store-credentials director-notary --apple-id <id> --team-id <team>
// Without a Developer ID it falls back to an ad-hoc signature (runs on this Mac only). --adhoc forces that.
import { execFileSync, spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktop = join(root, 'apps', 'desktop');
const app = join(desktop, 'release', 'mac-arm64', 'Director.app');
const step = (cmd, args, cwd = root, env = {}) => execFileSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });

function developerId() {
  if (process.argv.includes('--adhoc')) return null;
  if (process.env.DIRECTOR_SIGN_IDENTITY) return process.env.DIRECTOR_SIGN_IDENTITY;
  const out = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }).stdout ?? '';
  return out.match(/"(Developer ID Application: [^"]+)"/)?.[1] ?? null;
}
const identity = developerId();
const profile = process.env.DIRECTOR_NOTARY_PROFILE ?? 'director-notary';

if (!process.argv.includes('--skip-sidecars')) step('node', ['scripts/release/bundle-sidecars.mjs']);
step('node', ['scripts/release/stage-app.mjs']);

// Homebrew bottles target the macOS they were built on, so the app can only promise the newest minimum among them.
const sidecars = join(desktop, 'build', 'sidecars');
const minos = (f) => /minos (\S+)/.exec(spawnSync('vtool', ['-show-build', f], { encoding: 'utf8' }).stdout ?? '')?.[1] ?? '0';
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0); return false; };
let minimum = '15.0';
for (const sub of ['bin', 'lib']) for (const f of readdirSync(join(sidecars, sub))) { const v = minos(join(sidecars, sub, f)); if (newer(v, minimum)) minimum = v; }
console.log(`minimum macOS: ${minimum} (the newest any bundled binary needs)`);
const signArgs = identity
  ? ['-c.mac.identity=' + identity.replace(/^Developer ID Application: /, ''), '-c.mac.hardenedRuntime=true', '-c.mac.gatekeeperAssess=false',
     '-c.mac.entitlements=build/resources/entitlements.mac.plist', '-c.mac.entitlementsInherit=build/resources/entitlements.mac.plist']
  : [];
step('npx', ['electron-builder', '--mac', 'dir', '--arm64', '--config', 'electron-builder.yml', '--publish', 'never', `-c.mac.minimumSystemVersion=${minimum}`, ...signArgs], desktop, { CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
console.log(`packaged ${app}`);
if (!identity) { console.log('signed ad-hoc (runs on this Mac). Add a Developer ID Application certificate to sign for other Macs.'); process.exit(0); }
step('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
console.log(`signed with ${identity} (hardened runtime)`);
const hasProfile = spawnSync('xcrun', ['notarytool', 'history', '--keychain-profile', profile], { encoding: 'utf8' }).status === 0;
if (!hasProfile) { console.log(`not notarized: no notarytool keychain profile "${profile}". Create it with: xcrun notarytool store-credentials ${profile} --apple-id <your Apple ID> --team-id <team id>`); process.exit(0); }
const zip = join(desktop, 'release', 'Director-notarize.zip');
step('ditto', ['-c', '-k', '--keepParent', app, zip]);
step('xcrun', ['notarytool', 'submit', zip, '--keychain-profile', profile, '--wait']);
step('xcrun', ['stapler', 'staple', app]);
step('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
console.log(`notarized and stapled: Director.app opens on any Apple Silicon Mac with macOS ${minimum} or later`);
