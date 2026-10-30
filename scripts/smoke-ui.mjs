// Fast UI smoke test for CI: sets the owner password with the setup token,
// signs in, opens a page and fails on any page or console error. Run it
// against a fresh server on a scratch wiki (CI seeds `wiki/a.md`), never the
// real one.
//
//   LLM_WIKI_URL=http://127.0.0.1:8080 LLM_WIKI_SETUP_TOKEN=… node scripts/smoke-ui.mjs
import { chromium } from 'playwright'
import assert from 'node:assert/strict'

const base = process.env.LLM_WIKI_URL ?? 'http://127.0.0.1:8080'
const token = process.env.LLM_WIKI_SETUP_TOKEN
assert.ok(token, 'LLM_WIKI_SETUP_TOKEN is required')

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
})
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(`page error: ${error.message}`))
  page.on(
    'console',
    (message) =>
      message.type() === 'error' && errors.push(`console: ${message.text()}`),
  )

  await page.goto(base)
  await page.waitForSelector('#token')
  await page.fill('#token', token)
  await page.fill('#password', 'correct horse battery staple')
  await page.click('button[type=submit], form button.primary')
  await page.waitForSelector('text=Operational memory')

  await page.goto(`${base}/page/a`)
  await page.waitForSelector('article h1')
  assert.equal((await page.locator('article h1').textContent())?.trim(), 'A')
  assert.equal(
    await page.locator('.prose-wiki a.wiki-link:not(.broken)').count(),
    1,
    'the [[index]] link resolves',
  )

  assert.deepEqual(errors, [], 'no errors in the browser')
  console.log('UI smoke test passed')
} finally {
  await browser.close()
}
