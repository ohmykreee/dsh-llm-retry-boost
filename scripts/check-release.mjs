#!/usr/bin/env node
/**
 * Release guard for @ohmykreee/dsh-llm-retry-boost.
 *
 * The publish workflow runs this before `npm publish`, so a release cannot ship
 * a manifest that is still private, a tag that disagrees with the version, a
 * bundle row or browser factory that no longer names the package, or a tarball
 * that misses a runtime file.
 *
 * Usage:
 *   node scripts/check-release.mjs                 # manifest + layout + tarball
 *   node scripts/check-release.mjs --tag v1.0.1    # also require that tag
 */

import { execSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tagIndex = process.argv.indexOf('--tag')
const tag = tagIndex >= 0 ? String(process.argv[tagIndex + 1] || '').trim() : ''

if (tagIndex >= 0 && !tag) {
  console.error('--tag requires the pushed tag name, e.g. --tag v1.0.1')
  process.exit(2)
}

const problems = []
const checks = []

function fail(message, hint) {
  problems.push(hint ? `${message}\n    ${hint}` : message)
}

function pass(summary) {
  checks.push(summary)
}

function read(relative) {
  return readFileSync(path.join(root, relative), 'utf8')
}

function exists(relative) {
  try {
    return statSync(path.join(root, relative)).isFile()
  } catch {
    return false
  }
}

const manifest = JSON.parse(read('package.json'))
const name = String(manifest.name || '')
const version = String(manifest.version || '')

// ------------------------------------------------------------------ manifest
if (!/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(name)) {
  fail(`package name is not a publishable scoped name: ${JSON.stringify(name)}`)
}
if (manifest.private === true) {
  fail('package.json still declares "private": true, which npm refuses to publish')
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  fail(`version is not a release semver: ${JSON.stringify(version)}`)
}
if (manifest.publishConfig?.access !== 'public') {
  fail('publishConfig.access must be "public": scoped packages default to restricted')
}
if (manifest.publishConfig?.registry !== 'https://registry.npmjs.org/') {
  fail('publishConfig.registry must be https://registry.npmjs.org/')
}
if (manifest.publishConfig?.provenance !== true) {
  fail('publishConfig.provenance must be true to attach the build attestation')
}
if (!String(manifest.repository?.url || '').includes('github.com/ohmykreee/dsh-llm-retry-boost')) {
  fail('repository.url must be the GitHub repository, or npm cannot attest provenance')
}
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
  fail('dsh.bundle.patch must point at ./cordis.patch.yml')
}

// pnpm blocks dependency build scripts and DSH turns that into a failed install,
// so a published bundle must not declare install scripts at all.
const installScripts = ['preinstall', 'install', 'postinstall', 'prepare'].filter(
  (key) => manifest.scripts?.[key],
)
if (installScripts.length > 0) {
  fail(`package.json declares install-time scripts: ${installScripts.join(', ')}`)
}

const patchName = /name:\s*['"]?([^'"\s]+)/.exec(read('cordis.patch.yml'))?.[1]
if (patchName !== name) {
  fail(
    `cordis.patch.yml registers ${JSON.stringify(patchName)} but the package is ${JSON.stringify(name)}`,
    'the loader row must resolve to this package',
  )
}

const clientId = /__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/.exec(read('client.js'))?.[1]
if (clientId !== name) {
  fail(
    `client.js registers the browser factory as ${JSON.stringify(clientId)} but the package is ${JSON.stringify(name)}`,
    'DSH resolves the client entry under the package name',
  )
}

// -------------------------------------------------------------------- layout
const required = [
  'package.json',
  'lib/index.js',
  'lib/engine.js',
  'lib/policy.js',
  'lib/config.js',
  'client.js',
  'cordis.patch.yml',
  'locale/en.json',
  'locale/zh.json',
  'icon.svg',
  'README.md',
  'LICENSE',
]
const missing = required.filter((file) => !exists(file))
if (missing.length > 0) fail(`missing required files: ${missing.join(', ')}`)

// ---------------------------------------------------------------- tag guard
if (tag) {
  if (tag.replace(/^v/, '') !== version) {
    fail(
      `tag ${JSON.stringify(tag)} does not match package version ${version}`,
      'push the tag for the version in package.json, e.g. `git tag v1.0.1`',
    )
  } else {
    pass(`tag ${tag} matches version ${version}`)
  }
}

// -------------------------------------------------------------- tarball check
let report = null
try {
  const stdout = execSync('npm pack --dry-run --json --ignore-scripts', {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
  })
  const start = stdout.indexOf('[')
  report = start >= 0 ? JSON.parse(stdout.slice(start))[0] : null
} catch (error) {
  fail(
    `npm pack --dry-run failed: ${String(error.stderr || error.message).trim().split('\n').slice(-3).join(' ')}`,
  )
}

if (report && Array.isArray(report.files)) {
  const packed = new Set(report.files.map((file) => file.path))
  const omitted = required.filter((file) => !packed.has(file))
  if (omitted.length > 0) {
    fail(`the tarball omits: ${omitted.join(', ')}`, 'add the path to package.json `files`')
  }
  const leaked = [...packed].filter(
    (entry) => entry.startsWith('.github/') || entry.startsWith('node_modules/') || entry.startsWith('.git/') || entry.startsWith('scripts/'),
  )
  if (leaked.length > 0) {
    fail(`the tarball would ship forbidden paths: ${leaked.slice(0, 5).join(', ')}`)
  }
  if (Number(report.unpackedSize || 0) > 1024 * 1024) {
    fail(`the unpacked tarball is ${(report.unpackedSize / 1024 / 1024).toFixed(1)} MiB, over the 1 MiB budget`)
  }
  if (omitted.length === 0 && leaked.length === 0) {
    pass(
      `tarball ${report.filename}: ${report.entryCount} files, ${(report.unpackedSize / 1024).toFixed(1)} KiB unpacked`,
    )
  }
} else if (!problems.length) {
  fail('could not parse `npm pack --dry-run --json` output')
}

if (problems.length > 0) {
  console.error(`\n${name}@${version} is not publishable:\n`)
  for (const problem of problems) console.error(`  ✗ ${problem}`)
  console.error('')
  process.exit(1)
}

console.log(`${name}@${version} is ready to publish`)
for (const check of checks) console.log(`  ✓ ${check}`)
