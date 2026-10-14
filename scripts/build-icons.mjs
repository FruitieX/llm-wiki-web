// Renders public/icon.svg to the PNG sizes iOS and Android home screens use.
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const svg = readFileSync('public/icon.svg', 'utf8')
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
})
const page = await browser.newPage()
for (const size of [192, 512]) {
  await page.setViewportSize({ width: size, height: size })
  // Full-bleed square: home screens apply their own mask.
  await page.setContent(
    `<style>html,body{margin:0;background:#2b6b5f}</style>${svg.replace('<svg ', `<svg width="${size}" height="${size}" `).replace('rx="14"', 'rx="0"')}`,
  )
  await page.screenshot({
    path: `public/icon-${size}.png`,
    omitBackground: false,
  })
}
await browser.close()
