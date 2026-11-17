<script setup lang="ts">
import { ref } from 'vue'
import type { Track } from '../../../shared/types'
import { usePlayerStore } from '../stores/player'
import { formatTime } from '../utils/format'
import CoverImage from './CoverImage.vue'
import { useVirtualList } from '../composables/useVirtualList'

const player = usePlayerStore()

const keyword = ref('')
const results = ref<Track[]>([])
const page = ref(0)
const hasMore = ref(false)
const searching = ref(false)
const status = ref('')
const searchVersion = ref(0)
const props = withDefaults(defineProps<{ active?: boolean }>(), { active: true })
const { listEl, rows, top, bottom } = useVirtualList(() => results.value, {
  active: () => props.active,
  resetKey: () => searchVersion.value
})

async function search(reset = true): Promise<void> {
  const query = keyword.value.trim()
  if (!query) return

  searching.value = true
  status.value = ''
  try {
    const nextPage = reset ? 1 : page.value + 1
    const result = await window.api.search(query, nextPage)
    page.value = nextPage
    hasMore.value = result.hasMore
    results.value = reset ? result.list : [...results.value, ...result.list]
    if (reset) searchVersion.value += 1
    if (!results.value.length) status.value = '没有找到结果，换个关键词试试'
  } catch (error) {
    status.value = (error as Error).message
  } finally {
    searching.value = false
  }
}

function addAll(): void {
  player.append(results.value)
  status.value = `已加入 ${results.value.length} 首到播放队列`
}

function playNow(track: Track): void {
  player.append([track])
  void player.playAt(player.queue.length - 1)
}
</script>

<template>
  <section class="panel">
    <div class="panel-head">
      <span>搜索 B 站视频</span>
    </div>

    <div class="toolbar">
      <input
        v-model="keyword"
        class="search-input"
        type="text"
        placeholder="搜索歌名 / 歌手"
        @keyup.enter="search(true)"
      />
      <button class="primary" :disabled="searching" @click="search(true)">
        {{ searching ? '搜索中…' : '搜索' }}
      </button>
      <button class="ghost" :disabled="!results.length" @click="addAll">全部加入</button>
    </div>

    <p v-if="status" class="hint">{{ status }}</p>

    <div v-if="!results.length" class="empty">输入关键词，或把想听的收藏夹存到「我的收藏夹」</div>

    <ul v-else ref="listEl" class="list">
      <li class="virtual-spacer" aria-hidden="true" :style="{ height: `${top}px` }" />
      <li v-for="{ item: track, index } in rows" :key="track.id + index" class="row">
        <CoverImage class="cover" :src="track.cover" :size="88" alt="" loading="lazy" />
        <div class="row-main">
          <div class="row-title" :title="track.title">{{ track.title }}</div>
          <div class="row-sub">{{ track.owner }} · {{ formatTime(track.duration) }}</div>
        </div>
        <button class="pill" @click="player.append([track])">加入</button>
        <button class="pill" @click="player.playNext(track)">下一首</button>
        <button class="pill play" @click="playNow(track)">播放</button>
      </li>
      <li class="virtual-spacer" aria-hidden="true" :style="{ height: `${bottom}px` }" />
    </ul>

    <div v-if="hasMore" class="more">
      <button class="ghost" :disabled="searching" @click="search(false)">加载更多</button>
    </div>
  </section>
</template>

<style scoped>
.more {
  display: flex;
  justify-content: center;
  padding: 0 0 16px;
}
</style>
