/**
 * ESM host build for dsh-pr-watcher: the host service plugin and the
 * model-facing tool plugin, each bundled from its TypeScript source.
 * `@deepseek-ai/dsh-*` and cordis stay external (the profile's node_modules
 * provides them); schemastery is bundled because the Loader validates Config
 * against it.
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

mkdirSync('lib', { recursive: true })

const dshExternal = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-*']

for (const [entry, outfile] of [
  ['src/pr-watcher/index.ts', 'lib/pr-watcher/index.js'],
  ['src/tool-pr-watcher/index.ts', 'lib/tool-pr-watcher/index.js'],
  ['src/skill-pr-watcher/index.ts', 'lib/skill-pr-watcher/index.js'],
]) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node22'],
    sourcemap: true,
    external: dshExternal,
    logLevel: 'info',
  })
}

// Re-export the service surface from the package root for `.` importers;
// `src/index.ts` is also the declaration entry for `exports["."]`.
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  external: dshExternal,
  logLevel: 'info',
})

// Type declarations for the `exports.types` entries. esbuild strips types, so
// `tsc` emits them separately from the same sources into `lib/types`.
execFileSync(
  process.execPath,
  [fileURLToPath(import.meta.resolve('typescript/bin/tsc')), '-p', 'tsconfig.build.json'],
  { stdio: 'inherit' },
)
