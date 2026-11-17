import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron'
import { join } from 'node:path'
import type { PlayerCommand } from '../shared/types'

/**
 * 托盘图标路径：
 * - 打包后：electron-builder 会把 build/ 目录内容复制到 resources/，
 *   通过 process.resourcesPath 访问，避免 asar 内路径解析失败导致托盘不显示。
 * - 开发态：直接用源码目录的 resources/tray.png。
 */
function getTrayIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'tray.png')
    : join(__dirname, '../../resources/tray.png')
}

export function createTray(win: BrowserWindow): Tray {
  const icon = nativeImage.createFromPath(getTrayIconPath())
  if (icon.isEmpty()) {
    console.warn('[tray] icon not found:', getTrayIconPath())
  }
  const tray = new Tray(icon)
  tray.setToolTip('BiliBili Music')

  const send = (command: PlayerCommand) => {
    if (!win.isDestroyed()) win.webContents.send('player:command', command)
  }
  const showWindow = () => {
    win.show()
    win.focus()
  }

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示窗口', click: showWindow },
      { type: 'separator' },
      { label: '上一首', click: () => send('prev') },
      { label: '播放 / 暂停', click: () => send('toggle') },
      { label: '下一首', click: () => send('next') },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ])
  )

  tray.on('click', () => {
    if (win.isVisible()) win.hide()
    else showWindow()
  })

  return tray
}
