// Bundles the type-safe verification entry with the same @ alias as Vite,
// then runs it under Node. Usage: node scripts/run-verify.mjs
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = resolve(root, 'node_modules/.verify-build/verify-wire.mjs')

await build({
  entryPoints: [resolve(root, 'scripts/verify-wire.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  logLevel: 'warning',
  alias: { '@': resolve(root, 'src') },
})

await import(`file://${outfile}?t=${Date.now()}`)
