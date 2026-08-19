// Convert the source logo into the icons the app needs:
//   build/icon.png              (1024² real PNG — electron-builder app icon)
//   build/icon.ico              (Windows installer / taskbar icon)
//   src/renderer/public/icon.png (favicon + in-app logo)
//
// Run with: node scripts/make-icons.mjs [sourcePath]
import { Jimp } from 'jimp'
import png2icons from 'png2icons'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const source = process.argv[2] || 'build/icon.png'

const img = await Jimp.read(readFileSync(source))
img.cover({ w: 1024, h: 1024 })
const png = await img.getBuffer('image/png')

mkdirSync('build', { recursive: true })
mkdirSync('src/renderer/public', { recursive: true })
writeFileSync('build/icon.png', png)
writeFileSync('src/renderer/public/icon.png', png)

const ico = png2icons.createICO(png, png2icons.BILINEAR, 0, false)
if (!ico) throw new Error('Failed to build icon.ico from PNG.')
writeFileSync('build/icon.ico', ico)

console.log(`icons written — png ${png.length} bytes, ico ${ico.length} bytes`)
