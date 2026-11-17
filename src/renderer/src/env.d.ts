/// <reference types="vite/client" />

import type { BiliApi } from '../../preload'

declare global {
  interface Window {
    api: BiliApi
  }
}

export {}
