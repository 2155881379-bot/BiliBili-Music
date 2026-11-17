import { app, BrowserWindow, ipcMain, shell, Tray } from 'electron'
import { join } from 'node:path'
import { getAudio, getFavFolder, getVideo, parseFavMediaId, searchVideo } from './bili/api'
import { installHeaderRules, warmUp } from './bili/client'
import {
  flushState,
  getPlayerState,
  listFolders,
  listLikes,
  removeFolder,
  saveLikes,
  savePlayback,
  setPlayerState,
  upsertFolder
} from './state'
import { runQuitFlush } from './state-store'
import { createTray } from './tray'
import type { PersistedState, SavedFolder, Track } from '../shared/types'

// 让 Chromium 接管硬件媒体键，并注册系统媒体卡片（Windows 上的 SMTC）
app.commandLine.appendSwitch('enable-features', 'HardwareMediaKeyHandling,MediaSessionService')
app.setAppUserModelId('com.bilibili.music')

// 单实例锁：双击图标或再次启动时，只激活已有窗口，不创建新进程
const gotInstanceLock = app.requestSingleInstanceLock()
if (!gotInstanceLock) {
  app.quit()
}

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
/** 退出 flush 是否已发起过一次：before-quit 首次阻止并等 flush，再次直接放行。 */
let quitFlushStarted = false

/** 把窗口「可见且未最小化」状态广播给渲染进程。 */
function notifyVisibility(): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send('win:visible', win.isVisible() && !win.isMinimized())
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 880,
    minHeight: 560,
    show: false,
    backgroundColor: '#0a0a10',
    autoHideMenuBar: true,
    title: 'BiliBili Music',
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      spellcheck: false
    }
  })

  win.on('ready-to-show', () => {
    win?.show()
    notifyVisibility()
  })

  // 通知渲染进程最大化状态变化，用于切换最大化按钮图标
  const notifyMaximized = (): void => win?.webContents.send('win:maximized', win.isMaximized())
  win.on('maximize', notifyMaximized)
  win.on('unmaximize', notifyMaximized)

  // 可见性变化广播：show / hide / minimize / restore 都覆盖。
  win.on('show', notifyVisibility)
  win.on('hide', notifyVisibility)
  win.on('minimize', notifyVisibility)
  win.on('restore', notifyVisibility)

  // 关闭按钮收进托盘，播放不中断
  win.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    win?.hide()
    notifyVisibility()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

function registerIpc(): void {
  ipcMain.handle('bili:search', (_event, keyword: string, page?: number) =>
    searchVideo(keyword, page ?? 1)
  )
  ipcMain.handle('bili:video', (_event, bvid: string) => getVideo(bvid))
  ipcMain.handle('bili:audio', (_event, bvid: string, cid: number) => getAudio(bvid, cid))
  ipcMain.handle('bili:fav', (_event, mediaId: string, page?: number) =>
    getFavFolder(mediaId, page ?? 1)
  )
  ipcMain.handle('bili:parseFav', (_event, raw: string) => parseFavMediaId(raw))

  ipcMain.handle('state:load', () => getPlayerState())
  // 全量保存（含 queue）：渲染进程在 queue 变化时调用。
  ipcMain.on('state:save', (_event, state: PersistedState) => setPlayerState(state))
  // 进度补丁（不含 queue）：高频进度更新只覆盖标量，不丢 queue。
  ipcMain.on('state:save-playback', (_event, patch: Omit<PersistedState, 'queue'>) =>
    savePlayback(patch)
  )

  ipcMain.handle('library:list', () => listFolders())
  ipcMain.handle('library:save', (_event, folder: SavedFolder) => upsertFolder(folder))
  ipcMain.handle('library:remove', (_event, id: string) => removeFolder(id))

  ipcMain.handle('likes:list', () => listLikes())
  ipcMain.handle('likes:save', (_event, likes: Track[]) => saveLikes(likes))

  ipcMain.on('win:hide', () => {
    win?.hide()
    notifyVisibility()
  })
  ipcMain.on('win:minimize', () => {
    win?.minimize()
    notifyVisibility()
  })
  ipcMain.on('win:maximize', () => {
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle('win:isMaximized', () => win?.isMaximized() ?? false)
  ipcMain.handle('win:isVisible', () => (win ? win.isVisible() && !win.isMinimized() : false))
}

app.whenReady().then(() => {
  installHeaderRules()
  void warmUp()
  registerIpc()
  createWindow()
  if (win) tray = createTray(win)

  // 第二次启动时：还原并聚焦已有窗口，不新建进程
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
    notifyVisibility()
  })
})

/**
 * 退出流程：首次 before-quit 阻止一次，先通知渲染进程做最后 flush 并等 ack，
 * ack 到达后再启动主进程落盘（这样渲染进程的最后一次保存会被等待落盘）。
 * 整体 2 秒超时，超时不再等待；任何错误只记录，不阻断退出。app.quit 重入不重复触发。
 */
app.on('before-quit', (event) => {
  if (quitting && quitFlushStarted) return
  quitting = true
  if (quitFlushStarted) return

  event.preventDefault()
  quitFlushStarted = true

  // 单一 ack promise + 单一命名监听：注册后再通知渲染进程，避免重复监听/重复通知。
  const onAck = (event: Electron.IpcMainEvent): void => {
    if (event.sender === win?.webContents) resolveAck(true)
  }
  let resolveAck: (v: boolean) => void = () => undefined
  const ackPromise = new Promise<boolean>((resolve) => {
    resolveAck = resolve
  })
  ipcMain.on('app:flush-ack', onAck)
  try {
    win?.webContents.send('app:before-quit')
  } catch (error) {
    console.error('[main] 通知渲染进程退出失败：', error)
  }

  void runQuitFlush(
    // startFlush：ack 完成后才真正启动主进程落盘，这样渲染进程最后保存会被等待落盘。
    () => flushState(),
    {
      onAck: () => ackPromise,
      onError: (error) => console.error('[main] 退出 flush 出错：', error)
    },
    2000
  ).finally(() => {
    // 超时或收到 ack 后都移除监听。
    ipcMain.removeListener('app:flush-ack', onAck)
    app.quit()
  })
})

app.on('window-all-closed', () => {
  // 常驻托盘，不随窗口关闭退出
})

app.on('activate', () => {
  if (!win) createWindow()
})
