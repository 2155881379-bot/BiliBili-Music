<script setup lang="ts">
import { useLibraryStore } from '../stores/library'
import { formatTime } from '../utils/format'
import CoverImage from './CoverImage.vue'
import { useVirtualList } from '../composables/useVirtualList'

const library = useLibraryStore()
const props = withDefaults(defineProps<{ active?: boolean }>(), { active: true })
const { listEl, rows, top, bottom } = useVirtualList(() => library.likes, { active: () => props.active })
</script>

<template>
  <section class="panel">
    <div class="panel-head">
      <span>我喜欢的 {{ library.likes.length }} 首</span>
      <span class="spacer" />
      <button class="ghost" :disabled="!library.likes.length" @click="library.enqueueLikes()">
        全部加入队列
      </button>
      <button class="primary" :disabled="!library.likes.length" @click="library.playLikes()">
        播放全部
      </button>
    </div>

    <p v-if="library.status" class="hint">{{ library.status }}</p>

    <div v-if="!library.likes.length" class="empty">
      还没有喜欢的歌，在「正在播放」里点心形按钮就能收藏
    </div>

    <ul v-else ref="listEl" class="list">
      <li class="virtual-spacer" aria-hidden="true" :style="{ height: `${top}px` }" />
      <li
        v-for="{ item: track, index } in rows"
        :key="track.id"
        class="row"
        @click="library.playLikes(index)"
      >
        <span class="row-num">{{ index + 1 }}</span>
        <CoverImage class="cover" :src="track.cover" :size="88" alt="" loading="lazy" />
        <div class="row-main">
          <div class="row-title" :title="track.title">{{ track.title }}</div>
          <div class="row-sub">{{ track.owner }}</div>
        </div>
        <span class="row-time">{{ formatTime(track.duration) }}</span>
        <button class="row-remove" title="取消喜欢" @click.stop="library.toggleLike(track)">×</button>
      </li>
      <li class="virtual-spacer" aria-hidden="true" :style="{ height: `${bottom}px` }" />
    </ul>
  </section>
</template>
