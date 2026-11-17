// Isolated Electron host. No Bilibili network, production profile, or installed player.
const { app, BrowserWindow, ipcMain, session, net } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

app.setName('bilibili-music-performance')
app.setPath('userData', process.env.BILI_TEST_PROFILE)
app.setPath('sessionData', process.env.BILI_TEST_PROFILE)
const fixture = JSON.parse(fs.readFileSync(process.env.BILI_TEST_FIXTURE, 'utf8'))
globalThis.testSaves = []
globalThis.testImages = []

function chunk(type, data) {
  const name = Buffer.from(type)
  const result = Buffer.alloc(data.length + 12)
  result.writeUInt32BE(data.length)
  name.copy(result, 4); data.copy(result, 8)
  // Chromium's PNG reader validates CRC; Node in Electron 33 has no zlib.crc32.
  let crc = 0xffffffff
  for (const byte of Buffer.concat([name, data])) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8)
  return result
}
const imageCache = new Map()
function image(width, height) {
  const key = `${width}x${height}`
  if (imageCache.has(key)) return imageCache.get(key)
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 3 + 1) + 1 + x * 3
    // Geometrically identical at all sizes, preserving cover crop and backdrop colors.
    raw[offset] = Math.round(50 + x / width * 150)
    raw[offset + 1] = Math.round(30 + y / height * 90)
    raw[offset + 2] = Math.round(100 + x / width * 90)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  const result = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))])
  imageCache.set(key, result)
  return result
}
const pcm = Buffer.alloc(44 + 16000 * 180)
pcm.write('RIFF'); pcm.writeUInt32LE(pcm.length - 8, 4); pcm.write('WAVEfmt ', 8)
pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22)
pcm.writeUInt32LE(8000, 24); pcm.writeUInt32LE(16000, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34)
pcm.write('data', 36); pcm.writeUInt32LE(pcm.length - 44, 40)

app.whenReady().then(() => {
  // Prewarm fixture encoding before measuring the UI.
  image(1600, 1000)
  session.defaultSession.protocol.handle('https', (request) => {
    if (request.url.startsWith('https://bili-test.invalid/')) {
      return new Response(pcm, { headers: { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes' } })
    }
    if (request.url.startsWith('https://i0.hdslb.com/bfs/archive/perf-')) {
      const suffix = new URL(request.url).pathname.split('@')[1] || ''
      const requested = Number(suffix.match(/(?:^|_)(\d+)w/)?.[1] || 1600)
      const width = Math.max(1, Math.min(1600, requested))
      const height = Math.round(width * 1000 / 1600)
      globalThis.testImages.push({ url: request.url, width, height })
      return new Response(image(width, height), { headers: { 'Content-Type': 'image/png' } })
    }
    if (process.env.BILI_TEST_REAL_COVERS && new URL(request.url).hostname.endsWith('.hdslb.com')) {
      return net.fetch(request.url, {
        headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36' },
        bypassCustomProtocolHandlers: true,
        signal: AbortSignal.timeout(8000)
      })
    }
    return new Response('', { status: 404 })
  })
  ipcMain.handle('state:load', () => fixture.player)
  ipcMain.on('state:save', (_event, value) => globalThis.testSaves.push({ kind: 'full', queueLength: value.queue.length }))
  ipcMain.on('state:save-playback', (_event, value) => globalThis.testSaves.push({ kind: 'progress', hasQueue: 'queue' in value }))
  ipcMain.handle('library:list', () => fixture.folders)
  ipcMain.handle('library:save', (_event, folder) => { fixture.folders = [folder]; return fixture.folders })
  ipcMain.handle('library:remove', () => [])
  ipcMain.handle('likes:list', () => fixture.likes)
  ipcMain.handle('likes:save', (_event, likes) => { fixture.likes = likes; return likes })
  ipcMain.handle('bili:audio', () => ({ url: 'https://bili-test.invalid/silence.wav', backups: [] }))
  ipcMain.handle('bili:video', () => ({ title: 'fixture', pages: [{ cid: 1, page: 1, part: 'fixture', duration: 180 }] }))
  ipcMain.handle('bili:search', (_event, _query, page) => ({ list: fixture.player.queue.slice((page - 1) * 20, page * 20), page, total: 437, hasMore: page < 3 }))
  ipcMain.handle('win:isMaximized', () => false)
  const win = new BrowserWindow({
    width: 1080, height: 720, minWidth: 880, minHeight: 560, show: false, frame: false,
    backgroundColor: '#0a0a10', autoHideMenuBar: true,
    webPreferences: { preload: path.join(process.env.BILI_TEST_APP, 'preload/index.js'), sandbox: false, spellcheck: false }
  })
  ipcMain.on('win:hide', () => win.hide())
  ipcMain.on('win:minimize', () => win.minimize())
  ipcMain.handle('win:isVisible', () => win.isVisible() && !win.isMinimized())
  const notifyVisible = () => win.webContents.send('win:visible', win.isVisible() && !win.isMinimized())
  for (const event of ['show', 'hide', 'minimize', 'restore']) win.on(event, notifyVisible)
  win.on('ready-to-show', () => win.showInactive())
  void win.loadFile(path.join(process.env.BILI_TEST_APP, 'renderer/index.html'))
})
app.on('window-all-closed', () => app.quit())
