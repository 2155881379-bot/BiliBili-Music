<script setup lang="ts">
import { computed, ref } from 'vue'
import type { SavedFolder } from '../../../shared/types'
import { useLibraryStore } from '../stores/library'
import { usePlayerStore } from '../stores/player'
import { formatTime } from '../utils/format'
import CoverImage from './CoverImage.vue'
import { useVirtualList } from '../composables/useVirtualList'

const library = useLibraryStore()
const player = usePlayerStore()

const input = ref('')
const activeId = ref('')
const filter = ref('')
const active = computed(() => library.folders.find((item) => item.id === activeId.value) ?? null)

const filtered = computed(() => {
  const rows = (active.value?.tracks ?? []).map((track, index) => ({ track, index }))
  const query = filter.value.trim().toLowerCase()
  if (!query) return rows
  return rows.filter(
    ({ track }) =>
      track.title.toLowerCase().includes(query) || track.owner.toLowerCase().includes(query)
  )
})
const props = withDefaults(defineProps<{ active?: boolean }>(), { active: true })
const foldersList = useVirtualList(() => library.folders, { rowHeight: 68, active: () => props.active && !active.value })
const { listEl, rows, top, bottom } = useVirtualList(() => filtered.value, {
  active: () => props.active && !!active.value,
  resetKey: () => `${activeId.value}:${filter.value}`
})
// Template refs must be top-level refs rather than nested properties.
const folderListEl = foldersList.listEl
const folderRows = foldersList.rows
const folderTop = foldersList.top
const folderBottom = foldersList.bottom

async function submit(): Promise<void> {
  const folder = await library.importFolder(input.value)
  if (folder) {
    input.value = ''
    open(folder)
  }
}

function open(folder: SavedFolder): void {
  filter.value = ''
  activeId.value = folder.id
}

function back(): void {
  filter.value = ''
  activeId.value = ''
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('zh-CN')
}
</script>

<template>
  <section class="panel">
    <template v-if="!active">
      <div class="panel-head">
        <span>我的收藏夹</span>
        <span class="spacer" />
        <span v-if="library.importing" class="hint">导入中，请稍候…</span>
      </div>

      <div class="toolbar">
        <input
          v-model="input"
          type="text"
          placeholder="粘贴公开收藏夹链接，或填 media_id"
          @keyup.enter="submit"
        />
        <button class="primary" :disabled="library.importing" @click="submit">添加收藏夹</button>
      </div>

      <p v-if="library.status" class="hint">{{ library.status }}</p>

      <div v-if="!library.folders.length" class="empty">
        还没有保存的收藏夹，把 B 站收藏夹链接粘到上面即可长期保留
      </div>

      <ul v-else ref="folderListEl" class="list">
        <li class="virtual-spacer" aria-hidden="true" :style="{ height: `${folderTop}px` }" />
        <li v-for="{ item: folder } in folderRows" :key="folder.id" class="row folder" @click="open(folder)">
          <CoverImage class="cover" :src="folder.cover" :size="104" alt="" loading="lazy" />
          <div class="row-main">
            <div class="row-title" :title="folder.title">{{ folder.title }}</div>
            <div class="row-sub">
              {{ folder.tracks.length }} 首 · 更新于 {{ formatDate(folder.updatedAt) }}
            </div>
          </div>
          <button class="pill play" @click.stop="library.play(folder)">收听</button>
          <button
            class="row-remove"
            title="删除这个收藏夹"
            @click.stop="library.remove(folder.id)"
          >
            ×
          </button>
        </li>
        <li class="virtual-spacer" aria-hidden="true" :style="{ height: `${folderBottom}px` }" />
      </ul>
    </template>

    <template v-else>
      <div class="panel-head">
        <button class="back" @click="back">‹ 返回</button>
        <span class="folder-title" :title="active.title">{{ active.title }}</span>
        <span class="count">{{ active.tracks.length }} 首</span>
        <span class="spacer" />
        <button class="ghost" :disabled="library.importing" @click="library.refresh(active)">
          {{ library.importing ? '同步中…' : '同步最新' }}
        </button>
        <button class="ghost" @click="library.enqueue(active)">全部加入队列</button>
        <button class="primary" @click="library.play(active)">播放全部</button>
      </div>

      <div class="toolbar">
        <input v-model="filter" type="text" placeholder="在收藏夹里搜标题或 UP 主" />
        <span v-if="filter.trim()" class="match">{{ filtered.length }} 首匹配</span>
      </div>

      <p v-if="library.status" class="hint">{{ library.status }}</p>

      <ul v-if="filtered.length" ref="listEl" class="list">
        <li class="virtual-spacer" aria-hidden="true" :style="{ height: `${top}px` }" />
        <li
          v-for="{ item: row } in rows"
          :key="row.track.id + row.index"
          class="row"
          @click="library.play(active, row.index)"
        >
          <span class="row-num">{{ row.index + 1 }}</span>
          <CoverImage class="cover" :src="row.track.cover" :size="88" alt="" loading="lazy" />
          <div class="row-main">
            <div class="row-title" :title="row.track.title">{{ row.track.title }}</div>
            <div class="row-sub">{{ row.track.owner }}</div>
          </div>
          <button class="row-next" title="下一首播放" @click.stop="player.playNext(row.track)">
            下一首
          </button>
          <span class="row-time">{{ formatTime(row.track.duration) }}</span>
        </li>
        <li class="virtual-spacer" aria-hidden="true" :style="{ height: `${bottom}px` }" />
      </ul>

      <div v-else class="empty">没有匹配的歌曲</div>
    </template>
  </section>
</template>

<style scoped>
.folder .cover {
  width: 52px;
  height: 52px;
}

.back {
  padding: 4px 10px;
  color: var(--text-dim);
  border-radius: 7px;
}

.back:hover {
  color: var(--text);
  background: var(--panel-hover);
}

.folder-title {
  max-width: 340px;
  overflow: hidden;
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.count {
  font-size: 12px;
  color: var(--text-dim);
}

.match {
  font-size: 12px;
  color: var(--text-dim);
  white-space: nowrap;
}

.row-next {
  padding: 3px 9px;
  font-size: 11px;
  color: var(--text-dim);
  border: 1px solid var(--line);
  border-radius: 999px;
  opacity: 0;
  transition: opacity 0.12s;
}

.row:hover .row-next {
  opacity: 1;
}

.row-next:hover {
  color: var(--pink);
  border-color: var(--pink);
}

.panel-head .primary {
  padding: 6px 14px;
}
</style>
