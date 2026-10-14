// Drives the built app in Chromium: sign-in, reading, search, editing,
// saving, a concurrent upstream edit with the merge view, and phone layout.
//
//   LLM_WIKI_URL=http://127.0.0.1:3002 LLM_WIKI_SETUP_TOKEN=… \
//   LLM_WIKI_AGENT_CLONE=/path/to/clone-of-the-same-remote node scripts/verify-ui.mjs
//
// The agent clone must point at the same remote as the server (a scratch
// mirror, never the real wiki). Screenshots land in test-results/.
import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const base = process.env.LLM_WIKI_URL ?? 'http://127.0.0.1:3002'
const token = process.env.LLM_WIKI_SETUP_TOKEN
const password = process.env.LLM_WIKI_PASSWORD ?? 'correct horse battery staple'
const agent = process.env.LLM_WIKI_AGENT_CLONE
const out = 'test-results'
mkdirSync(out, { recursive: true })

let page
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
})
const failures = []
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures.push(what)
}
const git = (...args) =>
  execFileSync('git', ['-C', agent, ...args], { encoding: 'utf8' })

async function signIn(page) {
  await page.goto(base)
  await page.waitForSelector('#password')
  if (await page.locator('#token').count()) await page.fill('#token', token)
  await page.fill('#password', password)
  await page.click('button[type=submit], form button.primary')
  await page.waitForSelector('text=Operational memory')
}

const desktop = await browser.newContext({
  viewport: { width: 1440, height: 920 },
  colorScheme: 'light',
})
page = await desktop.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
// Conflicts (409) and checker rejections (422) are expected responses here.
page.on('console', (message) => {
  const text = message.text()
  if (message.type() === 'error' && !/status of (409|422)/.test(text))
    errors.push(text)
})

try {
  await signIn(page)
  check(true, 'signed in')
  await page.waitForSelector('text=Recently changed >> visible=true')
  await page.screenshot({ path: join(out, 'desktop-home.png') })

  await page.click('aside >> text=Agent start')
  await page.waitForSelector('article h1')
  check(
    (await page.locator('article h1').textContent())?.length > 0,
    'page renders a title',
  )
  check(
    (await page.locator('.prose-wiki a.wiki-link').count()) > 3,
    'wiki links render as links',
  )
  check(
    (await page.locator('.prose-wiki a.wiki-link.broken').count()) === 0,
    'agent-start has no broken links',
  )
  await page.screenshot({ path: join(out, 'desktop-page.png') })

  // Search from the keyboard.
  await page.keyboard.press('/')
  await page.fill('input[aria-label=Search]', 'homelab')
  await page.waitForSelector('[data-index="0"] mark')
  check(
    (await page.locator('[data-index]').count()) > 2,
    'search returns several hits',
  )
  await page.screenshot({ path: join(out, 'desktop-search.png') })
  await page.keyboard.press('Enter')
  await page.waitForURL(/\/page\//)

  // Edit a page: autocomplete, preview, check, commit.
  const target = 'concepts/verification-boundaries'
  await page.goto(`${base}/edit/${target}`)
  await page.waitForSelector('.cm-content')
  await page.click('.cm-content')
  await page.keyboard.press('Control+End')
  const stamp = Date.now().toString(36)
  await page.keyboard.type(`\n\nRun ${stamp}: see also [[entities/home`)
  await page.waitForSelector('.cm-tooltip-autocomplete')
  check(
    (
      await page.locator('.cm-tooltip-autocomplete li').first().textContent()
    )?.includes('entities/home'),
    '[[ autocompletes page paths',
  )
  // CodeMirror ignores Enter for a moment after the list opens.
  await page.waitForTimeout(150)
  await page.keyboard.press('Enter')
  await page.keyboard.type('.')
  await page.screenshot({ path: join(out, 'desktop-editor.png') })
  check(
    await page
      .waitForSelector(`.prose-wiki p:has-text("Run ${stamp}") a.wiki-link`, {
        timeout: 5000,
      })
      .then(
        () => true,
        () => false,
      ),
    'preview renders the new link',
  )
  // One tap: no dialog; the page opens and a toast follows the push.
  const tapped = Date.now()
  await page.click('header button:has-text("Save")')
  await page.waitForURL(new RegExp(`/page/${target}$`), { timeout: 20000 })
  const answered = Date.now() - tapped
  check(
    await page.waitForSelector(`.prose-wiki p:has-text("Run ${stamp}")`).then(
      () => true,
      () => false,
    ),
    `the page shows the edit right after Save (${answered} ms)`,
  )
  await page.screenshot({ path: join(out, 'desktop-saving.png') })
  await page.waitForSelector('text=Saved >> visible=true', { timeout: 90000 })
  const pushed = Date.now() - tapped
  await page.screenshot({ path: join(out, 'desktop-saved.png') })
  if (agent) {
    git('pull', '-q', '--ff-only')
    const subject = git('log', '-1', '--format=%s').trim()
    check(
      /^docs\(verification-boundaries\): /.test(subject),
      `the save is a commit on the remote after ${pushed} ms: ${subject}`,
    )
    check(
      git('show', 'HEAD:wiki/' + target + '.md').includes(`Run ${stamp}`),
      'the remote has the edit',
    )
  }

  // A broken link is blocked by the checker.
  await page.goto(`${base}/edit/${target}`)
  await page.waitForSelector('.cm-content')
  await page.click('.cm-content')
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\n\n[[entities/does-not-exist]]')
  await page.click('header button:has-text("Save")')
  await page.waitForSelector('text=broken wiki link', { timeout: 20000 })
  check(
    (await page
      .locator('text=Not saved: the wiki check found errors')
      .count()) === 1 && page.url().includes('/edit/'),
    'a new broken link blocks the save',
  )
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(out, 'desktop-check-error.png') })
  await page.keyboard.press('Escape')
  // Leave without saving (the draft is kept; discard it below).
  page.once('dialog', (dialog) => dialog.accept())

  if (agent) {
    // Concurrent edit: start editing, an agent pushes to the same page, then save.
    await page.goto(`${base}/page/${target}`)
    await page.goto(`${base}/edit/${target}`)
    await page
      .getByText('Discard it')
      .click()
      .catch(() => {})
    await page.waitForSelector('.cm-content')
    await page.click('.cm-content')
    const file = join(agent, 'wiki', `${target}.md`)
    // The agent edits an early line; the owner appends at the end, so git can
    // combine both and the merge view starts from the combined text.
    git('pull', '-q', '--ff-only')
    const before = readFileSync(file, 'utf8')
    const firstParagraph = before
      .split('\n')
      .findIndex((line, i) => i > 6 && line.trim() && !line.startsWith('#'))
    const lines = before.split('\n')
    lines[firstParagraph] +=
      ' An agent appended this sentence while the owner was editing.'
    writeFileSync(file, lines.join('\n'))
    git('commit', '-qam', 'docs(verification-boundaries): agent edit')
    git('push', '-q')
    await page.keyboard.press('Control+End')
    await page.keyboard.type('\nThe owner added this line.')
    await page.click('header button:has-text("Save")')
    await page.waitForSelector('text=Someone else changed this page', {
      timeout: 20000,
    })
    check(true, 'a concurrent upstream edit opens the merge view')
    check(
      (await page.locator('text=were combined').count()) === 1,
      'non-overlapping edits are combined automatically',
    )
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(out, 'desktop-merge.png') })
    await page.click('button:has-text("Use this version")')
    await page.waitForURL(new RegExp(`/page/${target}$`), { timeout: 20000 })
    await page.waitForSelector('text=Saved >> visible=true', { timeout: 90000 })
    git('pull', '-q', '--ff-only')
    const merged = readFileSync(file, 'utf8')
    check(
      merged.includes('An agent appended') &&
        merged.includes('The owner added'),
      'both edits survive the merge',
    )
  }

  // Checkboxes on a page save straight away.
  await page.goto(`${base}/page/personal/todo`)
  const box = page.locator('.prose-wiki input[type=checkbox]').first()
  await box.waitFor()
  const wasChecked = await box.isChecked()
  await box.click()
  const flipped = await page
    .waitForFunction(
      (was) =>
        document.querySelector('.prose-wiki input[type=checkbox]')?.checked !==
        was,
      wasChecked,
      { timeout: 1000 },
    )
    .then(
      () => true,
      () => false,
    )
  check(flipped, 'a checkbox toggles immediately')
  await page.waitForSelector('text=Saved >> visible=true', { timeout: 90000 })
  if (agent) {
    git('pull', '-q', '--ff-only')
    const subject = git('log', '-1', '--format=%s').trim()
    check(
      /^docs\(todo\): (un)?check "/.test(subject),
      `the checkbox is a commit: ${subject}`,
    )
  }
  await box.click()
  await page.waitForSelector('text=Saved >> visible=true', { timeout: 90000 })
  await page.waitForTimeout(2500)
  check((await box.isChecked()) === wasChecked, 'a second toggle sticks after the refetch')
  await page.screenshot({ path: join(out, 'desktop-checkbox.png') })

  // History and diff.
  await page.goto(`${base}/history/${target}`)
  await page.waitForSelector('.diff .row')
  check((await page.locator('.diff .add').count()) > 0, 'history shows a diff')
  await page.screenshot({ path: join(out, 'desktop-history.png') })

  // Dark theme.
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto(`${base}/page/entities/homelab`)
  await page.waitForSelector('article h1')
  await page.screenshot({ path: join(out, 'desktop-page-dark.png') })

  // Phone.
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    storageState: await desktop.storageState(),
  })
  const mobile = await phone.newPage()
  await mobile.goto(base)
  await mobile.waitForSelector('text=Operational memory')
  await mobile.screenshot({ path: join(out, 'phone-home.png') })
  const overflow = await mobile.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  )
  check(!overflow, 'no horizontal scroll on the phone home page')
  await mobile.click('button[aria-label="Open navigation"]')
  await mobile.waitForSelector('.drawer')
  await mobile.screenshot({ path: join(out, 'phone-drawer.png') })
  await mobile.click('.drawer >> text=Agent start')
  await mobile.waitForSelector('article h1')
  await mobile.screenshot({
    path: join(out, 'phone-page.png'),
    fullPage: false,
  })
  check(
    !(await mobile.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    )),
    'no horizontal scroll on a phone page',
  )
  await mobile.click('button[aria-label=Search]')
  await mobile.fill('input[aria-label=Search]', 'nfs')
  await mobile.waitForSelector('[data-index="0"] mark')
  await mobile.screenshot({ path: join(out, 'phone-search.png') })
  await mobile.goto(`${base}/edit/entities/homelab`)
  await mobile.waitForSelector('.cm-content')
  await mobile.screenshot({ path: join(out, 'phone-editor.png') })
  await mobile
    .click('button[role=tab]:has-text("Preview")')
    .catch(() => mobile.click('button[title=Preview]'))
  await mobile.screenshot({ path: join(out, 'phone-preview.png') })
} catch (error) {
  await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {})
  throw error
}
check(
  errors.length === 0,
  `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`,
)
await browser.close()
if (failures.length) {
  console.error(`${failures.length} check(s) failed`)
  process.exit(1)
}
