/**
 * merge-dist.mjs
 *
 * workout-tracker/dist/ → dist/workout/ にコピーする。
 * Vercel の outputDirectory が dist/ なので、
 * /workout/* は dist/workout/* から配信される。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT      = path.resolve(__dirname, '..')
const SRC       = path.join(ROOT, 'workout-tracker', 'dist')
const DEST      = path.join(ROOT, 'dist', 'workout')

if (!fs.existsSync(SRC)) {
  console.error(`[merge-dist] workout-tracker/dist/ not found at ${SRC}`)
  process.exit(1)
}

// Remove destination if exists, then recreate
if (fs.existsSync(DEST)) {
  fs.rmSync(DEST, { recursive: true })
}
fs.mkdirSync(DEST, { recursive: true })

copyDir(SRC, DEST)
console.log(`[merge-dist] Copied ${SRC} → ${DEST}`)

function copyDir(src, dest) {
  const entries = fs.readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath  = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true })
      copyDir(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}
