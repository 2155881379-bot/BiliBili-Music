// Run after npm run build. 90-second hard deadline, all actions bounded.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { _electron } = require('playwright')
const root = path.resolve(__dirname, '..')
const label = process.argv[2] || 'optimized'
const baseline = label.startsWith('baseline')
const output = path.join(root, 'output/playwright/performance')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-perf-check-'))
const appPath = baseline ? path.join(output, 'baseline-app') : path.join(root, 'out')
const tracks = Array.from({ length: 437 }, (_, i) => ({ id: `track-${i % 435}`, bvid: `BVfixture${i}`, cid: 1, page: 1, title: `性能测量歌曲 ${i + 1} · Performance fixture`, owner: `测试作者 ${i % 29}`, cover: `https://i0.hdslb.com/bfs/archive/perf-${i}.png`, duration: 180 }))
const realCovers = process.argv.includes('--real-covers')
if (realCovers) {
  const live = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'bilibili-music/state.json'), 'utf8'))
  const urls = (live.player?.queue || live.queue || []).map(track => track.cover).filter(Boolean)
  if (!urls.length) throw new Error('No real cover URLs available')
  tracks.forEach((track, index) => { track.cover = urls[index % urls.length] })
}
const fixture = { player: { queue: tracks, currentIndex: 156, volume: 0, mode: 'order', currentTime: 0 }, folders: [{ id: 'fixture', title: '性能测试收藏夹', cover: tracks[0].cover, updatedAt: 1700000000000, tracks: tracks.slice(0, 432) }], likes: tracks.slice(0, 100) }
fs.mkdirSync(output, { recursive: true })
fs.writeFileSync(path.join(profile, 'fixture.json'), JSON.stringify(fixture))
let electronApp
const results = { label, fixture: { tracks: 437, imageSize: realCovers ? 'real public CDN covers, synthetic song metadata' : '1600x1000', isolated: true }, errors: [], warnings: [] }
const deadline = setTimeout(() => {
  console.error('TIMEOUT: 90-second Electron budget exceeded; remaining cases need manual testing.')
  try { electronApp?.process().kill() } catch {}
  fs.writeFileSync(path.join(output, `${label}.json`), JSON.stringify({ ...results, timedOut: true }, null, 2))
  process.exit(3)
}, 90000)
function summary(values) {
  const sorted = [...values].sort((a,b) => a-b)
  return { n: sorted.length, p50: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))], max: sorted.at(-1) }
}
async function memory() {
  const processes = await electronApp.evaluate(({ app }) => app.getAppMetrics().map(({ pid, type, memory }) => ({ pid, type, ...memory })))
  const ids = processes.map(p => p.pid).join(',')
  try {
    const json = execFileSync('powershell.exe', ['-NoProfile', '-Command', `$wanted = @(${ids}); @(Get-CimInstance Win32_PerfRawData_PerfProc_Process | Where-Object { $_.IDProcess -in $wanted } | Select-Object IDProcess,WorkingSetPrivate) | ConvertTo-Json -Compress`], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    const counters = JSON.parse(json)
    for (const p of processes) p.privateWorkingSetMiB = Number(counters.find(c => Number(c.IDProcess) === p.pid)?.WorkingSetPrivate || 0) / 1048576
  } catch (error) { results.warnings.push(`private working set skipped after 5-second budget: ${error.message}`) }
  return { processes, privateWorkingSetMiB: processes.every(p => p.privateWorkingSetMiB !== undefined) ? processes.reduce((n,p) => n + p.privateWorkingSetMiB,0) : null }
}
async function run() {
  const env = { ...process.env, BILI_TEST_PROFILE: profile, BILI_TEST_APP: appPath, BILI_TEST_FIXTURE: path.join(profile, 'fixture.json'), ...(realCovers ? { BILI_TEST_REAL_COVERS: '1' } : {}) }
  delete env.ELECTRON_RUN_AS_NODE
  electronApp = await _electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'performance-main.cjs')], env, timeout: 20000 })
  const page = await electronApp.firstWindow({ timeout: 10000 })
  page.setDefaultTimeout(5000)
  page.on('pageerror', error => results.errors.push(error.message))
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia._s.get('player')?.queue.length === 437)
  const tab = text => page.locator('.nav button').filter({ hasText: text })
  if (process.argv.includes('--memory-only')) {
    await page.waitForTimeout(realCovers ? 2000 : 600)
    results.startMemory = await memory()
    await tab('播放队列').click()
    await page.waitForTimeout(realCovers ? 2000 : 600)
    results.queueMemory = await memory()
    await page.locator('.content .list').evaluate(list => { list.scrollTop = 0 })
    await page.evaluate(async () => {
      const list = document.querySelector('.content .list')
      for (let i = 0; i < 60; i++) {
        list.scrollTop = i * 420
        await new Promise(r => requestAnimationFrame(r))
      }
    })
    await page.waitForTimeout(600)
    results.scrollMemory = await memory()
    await page.locator('.now').click()
    await page.waitForTimeout(600)
    results.overlayMemory = await memory()
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
    await page.waitForTimeout(1200)
    results.trayMemory = await memory()
    results.hiddenRows = await page.locator('.row').count()
    results.images = await page.evaluate(() => ({ count: document.images.length, loaded: [...document.images].filter(image => image.naturalWidth > 0).length, maxWidth: Math.max(...[...document.images].map(image => image.naturalWidth)) }))
    fs.writeFileSync(path.join(output, `${label}.json`), JSON.stringify(results, null, 2))
    console.log(JSON.stringify(Object.fromEntries(['startMemory','queueMemory','scrollMemory','overlayMemory','trayMemory'].map(key => [key, results[key].privateWorkingSetMiB])), null, 2))
    return
  }
  const screenshot = async name => {
    // Original scrollIntoView scrolls overflow:hidden ancestors as well as the
    // list. Normalize that accidental outer offset for layout comparisons.
    await page.evaluate(() => document.querySelectorAll('.now-playing, .now-playing .queue, .now-playing .stage').forEach(el => { el.scrollTop = 0 }))
    await page.mouse.move(1070, 710)
    await page.waitForTimeout(180)
    await page.screenshot({ path: path.join(output, `${label}-${name}.png`) })
  }
  await screenshot('search-empty')
  await page.locator('.search-input').fill('fixture')
  await page.locator('.toolbar .primary').click()
  await page.waitForSelector('.content .row')
  await screenshot('search')
  await tab('我喜欢的').click()
  await screenshot('likes')
  await tab('我的收藏夹').click()
  await screenshot('folders')
  await page.locator('.folder .row-title').click()
  await screenshot('library')
  await page.locator('.toolbar input').fill('歌曲 20')
  await screenshot('filtered')
  const number = await page.locator('.content .row-num').first().innerText()
  assert.equal(number.trim(), '20', 'filter retains original song index')
  await tab('播放队列').click()
  await page.locator('.content .list').evaluate(list => { list.scrollTop = 0 })
  await screenshot('queue')
  results.queue = await page.evaluate(() => ({ rows: document.querySelectorAll('.content .row').length, height: document.querySelector('.content .list').clientHeight, scrollHeight: document.querySelector('.content .list').scrollHeight, firstRowHeight: document.querySelector('.content .row').getBoundingClientRect().height }))
  results.cachedScroll = await page.locator('.content .list').evaluate(list => { list.scrollTop = 1200; return list.scrollTop })
  await page.waitForTimeout(30)
  await tab('找歌').click()
  await tab('播放队列').click()
  const restoredScroll = await page.locator('.content .list').evaluate(list => list.scrollTop)
  if (!baseline) assert.equal(restoredScroll, results.cachedScroll, 'cached queue retains scroll instead of recentering')
  await page.locator('.content .list').evaluate(list => { list.scrollTop = 0 })
  await page.waitForTimeout(30)
  results.foreground = await memory()
  // Measure actual native drag handlers with a cross-viewport drop, preserving native source.
  results.drag = await page.evaluate(async () => {
    const list = document.querySelector('.content .list')
    const source = list.querySelector('[data-index="0"]')
    const transfer = new DataTransfer()
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }))
    await Promise.resolve(); await Promise.resolve()
    list.scrollTop = 350 * 60
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
    const target = list.querySelector('[data-index="350"]')
    if (!target) throw new Error('Cross-viewport drag target not rendered')
    let added = 0, removed = 0
    const observer = new MutationObserver(records => records.forEach(r => { added += r.addedNodes.length; removed += r.removedNodes.length }))
    observer.observe(list, { childList: true })
    const start = performance.now()
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    await Promise.resolve(); await Promise.resolve()
    const commitMs = performance.now() - start
    source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }))
    observer.disconnect()
    const player = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('player')
    return { commitMs, added, removed, movedId: player.queue[350].bvid, currentBvid: player.current.bvid, rows: list.querySelectorAll('.row').length }
  })
  assert.equal(results.drag.movedId, 'BVfixture0')
  assert.equal(results.drag.currentBvid, 'BVfixture156')
  results.scroll = await page.evaluate(async () => {
    const list = document.querySelector('.content .list')
    const frames = []; let previous
    for (let i = 0; i < 90; i++) {
      const now = await new Promise(r => requestAnimationFrame(r))
      if (previous !== undefined) frames.push(now - previous)
      previous = now
      list.scrollTop = (i % 44) * 600
    }
    return { frames, rows: list.querySelectorAll('.row').length }
  })
  results.scroll.frames = summary(results.scroll.frames)
  results.switch = summary(await page.evaluate(async () => {
    const tabs = [...document.querySelectorAll('.nav button')]
    const queue = tabs.find(el => el.textContent.includes('播放队列'))
    const search = tabs.find(el => el.textContent.includes('找歌'))
    const samples = []
    for (let i = 0; i < 10; i++) {
      search.click(); await Promise.resolve(); await Promise.resolve()
      const start = performance.now()
      queue.click(); await Promise.resolve(); await Promise.resolve()
      samples.push(performance.now() - start)
      await new Promise(r => requestAnimationFrame(r))
    }
    return samples
  }))
  results.stressMemory = await memory()
  // Reset deterministic queue so all screenshots can be compared pixel-for-pixel.
  await page.evaluate(tracks => {
    const p = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('player')
    p.replaceQueue(tracks, 156)
  }, tracks)
  await page.waitForTimeout(100)
  await page.locator('.player .controls .main').click() // pause fixture audio
  results.overlay = await page.evaluate(async () => {
    const start = performance.now(); document.querySelector('.now').click()
    await Promise.resolve(); await Promise.resolve()
    return { commitMs: performance.now() - start, rows: document.querySelectorAll('.row').length, elements: document.querySelectorAll('*').length }
  })
  await page.waitForSelector('.now-playing')
  await page.locator('.now-playing .list').evaluate(list => { list.scrollTop = 0 })
  await screenshot('now')
  results.overlayMemory = await memory()
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(880, 560))
  await screenshot('now-minimum')
  await page.keyboard.press('Escape')
  await page.locator('.content .list').evaluate(list => { list.scrollTop = 0 })
  await screenshot('queue-minimum')
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1080, 720))
  if (process.argv.includes('--screenshots-only')) {
    console.log('Default/minimum screenshots captured.')
    return
  }
  if (!baseline) {
    // Actual Chromium DnD, including a source that leaves the virtual window.
    await page.locator('.content .list').evaluate(list => { list.scrollTop = 0 })
    await page.waitForTimeout(40)
    const first = page.locator('.content [data-index="0"]')
    const original = await first.locator('.row-title').innerText()
    const box = await first.boundingBox()
    await page.mouse.move(box.x + 40, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + 50, box.y + box.height / 2 + 12, { steps: 3 })
    await page.locator('.content .list').evaluate(list => { list.scrollTop = 1200 })
    await page.waitForTimeout(80)
    const target = page.locator('.content [data-index="22"]')
    const targetBox = await target.boundingBox()
    await page.mouse.move(targetBox.x + 60, targetBox.y + 30, { steps: 4 })
    await page.mouse.move(targetBox.x + 61, targetBox.y + 31)
    await page.mouse.up()
    await page.waitForTimeout(40)
    const moved = await page.locator('.content [data-index="22"] .row-title').innerText()
    assert.equal(moved, original, 'real native cross-viewport drag preserved source')
    results.realDrag = { crossViewport: true }
    results.edgeDrag = await page.evaluate(async () => {
      const list = document.querySelector('.content .list')
      const source = list.querySelector('.row')
      const transfer = new DataTransfer()
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }))
      const rect = list.getBoundingClientRect()
      const before = list.scrollTop
      list.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.left + 40, clientY: rect.bottom - 8 }))
      await new Promise(resolve => setTimeout(resolve, 120))
      const after = list.scrollTop
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }))
      return { before, after }
    })
    assert.ok(results.edgeDrag.after > results.edgeDrag.before, 'dragging near edge automatically scrolls the virtual list')
    // Click filtered library row and confirm the original queue index is played.
    await tab('我的收藏夹').click()
    await page.locator('.toolbar input').fill('歌曲 20')
    await page.locator('.content .row-title').first().click()
    await page.waitForFunction(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('player').currentIndex === 19)
    await tab('播放队列').click()
    // Large queues still render a bounded number of rows.
    await page.evaluate(track => {
      const p = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('player')
      p.replaceQueue(Array.from({ length: 5000 }, (_, i) => ({ ...track, id: `large-${i}` })), 0)
    }, tracks[0])
    await page.waitForTimeout(60)
    results.largeQueueRows = await page.locator('.content .row').count()
    assert.ok(results.largeQueueRows <= 40)
    await page.evaluate(tracks => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('player').replaceQueue(tracks, 156), tracks)
    // Confirm the real renderer/preload sends progress patches with no queue.
    // Explicit flush/ack establishes a queue-clean boundary, independent of
    // Chromium's background timer throttling after resize/drag.
    await electronApp.evaluate(async ({ BrowserWindow, ipcMain }) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { ipcMain.removeListener('app:flush-ack', ack); reject(new Error('Renderer flush acknowledgement timed out')) }, 2000)
        function ack() { clearTimeout(timer); resolve() }
        ipcMain.once('app:flush-ack', ack)
        BrowserWindow.getAllWindows()[0].webContents.send('app:before-quit')
      })
    })
    const before = await electronApp.evaluate(() => globalThis.testSaves.length)
    await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('player').setVolume(.13))
    await page.waitForTimeout(650)
    const patches = await electronApp.evaluate((_electron, offset) => globalThis.testSaves.slice(offset), before)
    assert.ok(patches.some(save => save.kind === 'progress' && !save.hasQueue), 'volume update sends scalar IPC')
    assert.ok(patches.every(save => save.kind !== 'full'), `volume update never clones full queue: ${JSON.stringify(patches)}`)
    results.incrementalSave = true
  }
  results.windowSwitch = []
  for (let i = 0; i < 3; i++) {
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
    await page.waitForTimeout(100)
    const start = performance.now()
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive())
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
    results.windowSwitch.push(performance.now() - start)
  }
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
  await page.waitForTimeout(1200)
  results.trayMemory = await memory()
  results.hiddenRows = await page.locator('.row').count()
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive())
  await page.waitForTimeout(200)
  results.images = await page.evaluate(() => ({ count: document.images.length, loaded: [...document.images].filter(i => i.naturalWidth).length, maxWidth: Math.max(...[...document.images].map(i => i.naturalWidth)), decodedElementMiB: [...document.images].reduce((n,i) => n + i.naturalWidth * i.naturalHeight * 4,0) / 1048576 }))
  results.ipc = await electronApp.evaluate(() => ({ saves: globalThis.testSaves, imageRequests: globalThis.testImages.length, maxImageWidth: Math.max(...globalThis.testImages.map(i => i.width)), imageSizes: Object.fromEntries(Object.entries(Object.groupBy(globalThis.testImages, i => i.width)).map(([width, images]) => [width, images.length])), originalRequests: globalThis.testImages.filter(i => i.width === 1600).slice(0, 8) }))
  if (!baseline && !process.argv.includes('--measure-only')) {
    assert.ok(results.queue.rows <= 40, 'queue DOM is bounded')
    assert.ok(results.overlay.rows <= 60, 'overlay avoids full duplicate queue')
    assert.ok(results.drag.added <= 5 && results.drag.removed <= 5, 'no mass DOM reconstruction')
    assert.ok(results.drag.commitMs < 50, 'drop below 50ms')
    assert.ok(results.switch.p95 < 16.7, 'cached switch stays within frame budget')
    assert.ok(results.hiddenRows === 0, 'hidden lists stop rendering')
  }
  assert.deepEqual(results.errors, [])
  fs.writeFileSync(path.join(output, `${label}.json`), JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ label, queue: results.queue, drag: results.drag, switch: results.switch, overlay: results.overlay, memory: { foreground: results.foreground.privateWorkingSetMiB, stress: results.stressMemory.privateWorkingSetMiB, overlay: results.overlayMemory.privateWorkingSetMiB, tray: results.trayMemory.privateWorkingSetMiB }, errors: results.errors }, null, 2))
}
run().catch(error => {
  results.errors.push(error.stack)
  fs.writeFileSync(path.join(output, `${label}.json`), JSON.stringify(results, null, 2))
  console.error(error.stack); process.exitCode = 1
}).finally(async () => {
  if (electronApp) {
    const child = electronApp.process()
    await Promise.race([electronApp.close(), new Promise(r => setTimeout(r, 3000))])
    if (child.exitCode === null) child.kill()
  }
  clearTimeout(deadline)
  const absolute = path.resolve(profile)
  const tempRoot = path.resolve(os.tmpdir()) + path.sep
  if (!absolute.startsWith(tempRoot) || !path.basename(absolute).startsWith('bili-perf-check-')) throw new Error('Unexpected test profile path')
  fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})
