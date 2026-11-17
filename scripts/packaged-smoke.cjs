// Actual packaged main/preload/renderer, isolated profile, no installed instance touched.
const { _electron } = require('playwright')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-packaged-smoke-'))
const statePath = path.join(profile, 'state.json')
const cover = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44"><rect width="44" height="44" fill="pink"/></svg>'
const tracks = Array.from({ length: 437 }, (_, i) => ({ id: `fixture-${i}`, bvid: `BVfixture${i}`, cid: 1, page: 1, title: `Smoke song ${i}`, owner: 'fixture', cover, duration: 180 }))
fs.writeFileSync(statePath, JSON.stringify({ player: { queue: tracks, currentIndex: -1, volume: .8, mode: 'order', currentTime: 0 }, folders: [], likes: [] }))
let app
let child
const timer = setTimeout(() => { child?.kill(); console.error('Packaged smoke exceeded 45 seconds; manual validation required.'); process.exit(3) }, 45000)
async function run() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  app = await _electron.launch({ executablePath: path.join(root, 'release/win-unpacked/BiliBili Music.exe'), args: [`--user-data-dir=${profile}`], env, timeout: 15000 })
  child = app.process()
  const page = await app.firstWindow({ timeout: 10000 })
  page.setDefaultTimeout(4000)
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia._s.get('player')?.queue.length === 437)
  const actualProfile = await app.evaluate(({ app }) => app.getPath('userData'))
  assert.equal(path.resolve(actualProfile), path.resolve(profile))
  const runtime = await app.evaluate(() => ({ electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node }))
  assert.equal(runtime.electron, require('electron/package.json').version, 'packaged Electron matches the installed version')
  await page.locator('.nav button').filter({ hasText: '播放队列' }).click()
  assert.ok(await page.locator('.content .row').count() < 40)
  await page.locator('.now').click()
  await page.waitForSelector('.now-playing')
  // Playwright clicks bypass Windows non-client hit testing. Check the computed
  // regions as well: inherited drag on the oversized backdrop covered the title
  // bar, and drag siblings intercepted the visible return button in v0.1.0.
  const dragRegions = await page.locator('.now-playing').evaluate(overlay =>
    [overlay, ...overlay.querySelectorAll('*')]
      .filter(el => getComputedStyle(el).getPropertyValue('-webkit-app-region') === 'drag')
      .map(el => `${el.tagName.toLowerCase()}.${el.getAttribute('class') || ''}`)
  )
  assert.deepEqual(dragRegions, [], 'Now Playing and its decorative layers must not create native drag regions')
  const backdropWithinOverlay = await page.locator('.now-playing').evaluate(overlay => {
    const bounds = overlay.getBoundingClientRect()
    const backdrop = overlay.querySelector('.backdrop').getBoundingClientRect()
    return backdrop.top >= bounds.top && backdrop.left >= bounds.left && backdrop.right <= bounds.right && backdrop.bottom <= bounds.bottom
  })
  assert.equal(backdropWithinOverlay, true, 'decorative no-drag backdrop must not extend over the draggable title bar')
  const controlsReceivePointer = await page.locator('.window-controls').evaluate(controls =>
    [...controls.querySelectorAll('button')].every(button => {
      const rect = button.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return button.contains(hit) && getComputedStyle(button).getPropertyValue('-webkit-app-region') === 'no-drag'
    })
  )
  assert.equal(controlsReceivePointer, true, 'title bar buttons remain exposed and outside native drag regions')
  const windowState = () => app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    return { minimized: win.isMinimized(), maximized: win.isMaximized(), visible: win.isVisible() }
  })
  await page.locator('.win-btn[title="最大化"]').click()
  await assertEventually(async () => (await windowState()).maximized, 'maximize button maximizes')
  await page.locator('.win-btn[title="还原"]').click()
  await assertEventually(async () => !(await windowState()).maximized, 'restore button restores')
  await page.locator('.win-btn[title="最小化"]').click()
  await assertEventually(async () => (await windowState()).minimized, 'minimize button minimizes')
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.restore(); win.show() })
  await page.locator('.win-btn[title="关闭"]').click()
  await assertEventually(async () => !(await windowState()).visible, 'close button hides to tray')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())
  await page.locator('.now-playing > .close').click()
  await page.waitForSelector('.now-playing', { state: 'detached' })
  await page.locator('.tray-btn').click()
  await page.waitForFunction(() => document.querySelectorAll('.row').length === 0)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())
  await page.waitForSelector('.content .row')
  // Queue mutation is deliberately left inside the debounce window; quit must flush it.
  await page.evaluate(track => {
    const player = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('player')
    player.append([track]); player.setVolume(.37)
  }, tracks[0])
  await app.evaluate(({ app }) => app.quit())
  await Promise.race([new Promise(r => child.exitCode !== null ? r() : child.once('exit', r)), new Promise((_, reject) => setTimeout(() => reject(new Error('Quit exceeded 4 seconds')), 4000))])
  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.equal(saved.player.queue.length, 438)
  assert.equal(saved.player.volume, .37)
  assert.deepEqual(errors, [])
  const result = { passed: true, packaged: true, runtime, isolatedProfile: true, queueRowsBounded: true, trayRestore: true, windowControls: true, nowPlayingReturn: true, noOverlayDragRegions: true, exitFlush: { queueLength: 438, volume: .37 }, errors }
  const output = path.join(root, 'output/playwright/performance')
  fs.mkdirSync(output, { recursive: true })
  fs.writeFileSync(path.join(output, 'packaged-smoke.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}
async function assertEventually(predicate, message) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.fail(message)
}
run().catch(error => { console.error(error.stack); process.exitCode = 1 }).finally(async () => {
  if (child && child.exitCode === null) {
    await Promise.race([app.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 1500))])
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve))
      child.kill()
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1000))])
    }
  }
  clearTimeout(timer)
  const absolute = path.resolve(profile)
  const tempRoot = path.resolve(os.tmpdir()) + path.sep
  if (!absolute.startsWith(tempRoot) || !path.basename(absolute).startsWith('bili-packaged-smoke-')) throw new Error('Unexpected smoke profile path')
  try {
    await fs.promises.rm(absolute, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch (error) {
    console.warn(`Isolated profile cleanup deferred: ${error.code}`)
  }
})
