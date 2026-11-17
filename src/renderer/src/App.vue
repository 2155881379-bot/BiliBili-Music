<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import LibraryView from './components/LibraryView.vue'
import LikesView from './components/LikesView.vue'
import NowPlaying from './components/NowPlaying.vue'
import PlayerBar from './components/PlayerBar.vue'
import QueueView from './components/QueueView.vue'
import SearchView from './components/SearchView.vue'
import { useLibraryStore } from './stores/library'
import { usePlayerStore } from './stores/player'

const player = usePlayerStore()
const library = useLibraryStore()
const tab = ref<'search' | 'likes' | 'library' | 'queue'>('search')
const expanded = ref(false)
const maximized = ref(false)
let offMaximized: (() => void) | undefined

const views = { search: SearchView, likes: LikesView, library: LibraryView, queue: QueueView }
const currentView = computed(() => views[tab.value])

function hideToTray(): void {
  window.api.hideWindow()
}

function minimizeWindow(): void {
  window.api.minimizeWindow()
}

function toggleMaximize(): void {
  window.api.toggleMaximize()
}

async function focusSearch(): Promise<void> {
  expanded.value = false
  tab.value = 'search'
  await nextTick()
  const input = document.querySelector<HTMLInputElement>('.search-input')
  input?.focus()
  input?.select()
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable
  )
}

function onKeydown(event: KeyboardEvent): void {
  if (isTyping(event.target)) return

  if (event.code === 'Space') {
    event.preventDefault()
    void player.toggle()
    return
  }
  if (event.ctrlKey && event.key === 'ArrowRight') {
    event.preventDefault()
    player.next()
    return
  }
  if (event.ctrlKey && event.key === 'ArrowLeft') {
    event.preventDefault()
    player.prev()
    return
  }
  if (event.ctrlKey && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    void focusSearch()
  }
}

onMounted(() => {
  void player.init()
  void library.init()
  window.api.isMaximized().then((v) => (maximized.value = v))
  offMaximized = window.api.onMaximizedChange((v) => (maximized.value = v))
  window.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  offMaximized?.()
})
</script>

<template>
  <div class="app">
    <header class="titlebar">
      <span class="titlebar-title">BiliBili Music</span>
      <div class="window-controls">
        <button class="win-btn" title="最小化" @click="minimizeWindow">
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <rect x="2" y="5.5" width="8" height="1" fill="currentColor" />
          </svg>
        </button>
        <button class="win-btn" :title="maximized ? '还原' : '最大化'" @click="toggleMaximize">
          <svg v-if="maximized" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 2v2H2v6h6V9h2V2H3zm1 1h4v1H4V3zm-2 3h5v4H2V6z" fill="currentColor" />
          </svg>
          <svg v-else viewBox="0 0 12 12" aria-hidden="true">
            <rect x="2.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1" />
          </svg>
        </button>
        <button class="win-btn close" title="关闭" @click="hideToTray">
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </header>

    <div class="body">
      <aside class="sidebar">
        <div class="brand">
          <span class="logo" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z" />
            </svg>
          </span>
          BiliBili<em>Music</em>
        </div>

        <nav class="nav">
          <button :class="{ active: tab === 'search' }" @click="tab = 'search'">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M10 4a6 6 0 1 0 3.71 10.71l4.3 4.3 1.41-1.42-4.3-4.29A6 6 0 0 0 10 4zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8z"
              />
            </svg>
            <span>找歌</span>
          </button>

          <button :class="{ active: tab === 'likes' }" @click="tab = 'likes'">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"
              />
            </svg>
            <span>我喜欢的</span>
            <span v-if="library.likes.length" class="badge">{{ library.likes.length }}</span>
          </button>

          <button :class="{ active: tab === 'library' }" @click="tab = 'library'">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 4h6.5v16H4zm9.5 0H20v16h-6.5z" />
            </svg>
            <span>我的收藏夹</span>
            <span v-if="library.folders.length" class="badge">{{ library.folders.length }}</span>
          </button>

          <button :class="{ active: tab === 'queue' }" @click="tab = 'queue'">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 6h11v1.6H4zm0 5h11v1.6H4zm0 5h7v1.6H4zm11.5-1.7 4.5 2.6-4.5 2.6z" />
            </svg>
            <span>播放队列</span>
            <span v-if="player.queue.length" class="badge">{{ player.queue.length }}</span>
          </button>
        </nav>

        <button class="ghost tray-btn" title="窗口收进托盘，音乐继续播放" @click="hideToTray">
          收进托盘
        </button>
      </aside>

      <main class="content">
        <KeepAlive>
          <component :is="currentView" :active="!expanded" />
        </KeepAlive>
      </main>
    </div>

    <PlayerBar @expand="expanded = true" />

    <NowPlaying v-if="expanded" @close="expanded = false" />
  </div>
</template>

<style scoped>
.titlebar {
  display: flex;
  align-items: center;
  height: 32px;
  padding: 0 0 0 12px;
  background: var(--panel);
  border-bottom: 1px solid var(--line-soft);
  -webkit-app-region: drag;
  flex-shrink: 0;
}

.titlebar-title {
  font-size: 12px;
  color: var(--text-dim);
  letter-spacing: 0.3px;
}

.window-controls {
  display: flex;
  margin-left: auto;
  -webkit-app-region: no-drag;
}

.win-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 32px;
  color: var(--text-dim);
}

.win-btn svg {
  width: 12px;
  height: 12px;
}

.win-btn:hover {
  color: var(--text);
  background: var(--panel-hover);
}

.win-btn.close:hover {
  color: #fff;
  background: #e81123;
}
</style>
