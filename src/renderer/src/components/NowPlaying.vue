<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useLibraryStore } from '../stores/library'
import { usePlayerStore } from '../stores/player'
import { getCoverImageUrl } from '../utils/cover'
import { formatTime } from '../utils/format'
import CoverImage from './CoverImage.vue'
import QueueView from './QueueView.vue'

const emit = defineEmits<{ (e: 'close'): void }>()
const player = usePlayerStore()
const library = useLibraryStore()

const liked = computed(() => library.isLiked(player.current))
const backdropUrl = computed(() =>
  player.current?.cover
    ? getCoverImageUrl(player.current.cover, { displayWidth: 512, dpr: 1 })
    : ''
)

function toggleLike(): void {
  if (player.current) void library.toggleLike(player.current)
}

const modeLabel = computed(() => ({ order: '顺序播放', single: '单曲循环', shuffle: '随机播放' })[player.mode])

const progressFill = computed(
  () => `${player.duration ? (player.currentTime / player.duration) * 100 : 0}%`
)
const volumeFill = computed(() => `${player.volume * 100}%`)

function onSeek(event: Event): void {
  player.seek(Number((event.target as HTMLInputElement).value))
}

function onVolume(event: Event): void {
  player.setVolume(Number((event.target as HTMLInputElement).value))
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <section class="now-playing">
    <div
      class="backdrop"
      :style="backdropUrl ? { backgroundImage: `url(${backdropUrl})` } : undefined"
    />

    <button class="close" title="收起（Esc）" @click="emit('close')">‹ 收起</button>

    <div class="stage">
      <CoverImage v-if="player.current" class="art" :src="player.current.cover" :size="496" alt="" />
      <div v-else class="art placeholder" />

      <h1 class="title">{{ player.current?.title ?? '还没有选择歌曲' }}</h1>
      <div class="owner">{{ player.current?.owner ?? '在左侧搜索或挑一个收藏夹开始' }}</div>

      <div class="progress">
        <span class="time">{{ formatTime(player.currentTime) }}</span>
        <input
          class="range"
          type="range"
          min="0"
          :max="player.duration || 0"
          step="1"
          :value="player.currentTime"
          :disabled="!player.duration"
          :style="{ '--fill': progressFill }"
          @input="onSeek"
        />
        <span class="time">{{ formatTime(player.duration) }}</span>
      </div>

      <div class="controls">
        <button class="icon-btn" title="上一首" @click="player.prev()">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 5h2v14H7zM19 5v14l-9-7z" />
          </svg>
        </button>
        <button class="icon-btn main" :title="player.playing ? '暂停' : '播放'" @click="player.toggle()">
          <svg v-if="player.playing" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
          </svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 5l11 7-11 7z" />
          </svg>
        </button>
        <button class="icon-btn" title="下一首" @click="player.next()">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 5h2v14h-2zM5 5l9 7-9 7z" />
          </svg>
        </button>
      </div>

      <div class="footer">
        <button
          class="like"
          :class="{ active: liked }"
          :title="liked ? '取消喜欢' : '喜欢这首'"
          @click="toggleLike"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"
            />
          </svg>
        </button>
        <button class="mode" @click="player.cycleMode()">{{ modeLabel }}</button>
        <span class="volume-label">音量</span>
        <input
          class="range vol"
          type="range"
          min="0"
          max="1"
          step="0.01"
          :value="player.volume"
          :style="{ '--fill': volumeFill }"
          @input="onVolume"
        />
      </div>

      <p v-if="player.notice || player.error" class="msg" :class="{ error: player.error }">
        {{ player.notice || player.error }}
      </p>
    </div>

    <aside class="queue">
      <QueueView />
    </aside>
  </section>
</template>

<style scoped>
.now-playing {
  position: fixed;
  top: 32px;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 40;
  display: flex;
  overflow: hidden;
  background: var(--bg);
}

.backdrop {
  position: absolute;
  inset: -80px;
  background-position: center;
  background-size: cover;
  filter: blur(64px) brightness(0.32);
  transform: scale(1.1);
}

.close {
  position: absolute;
  top: 40px;
  left: 16px;
  z-index: 2;
  padding: 6px 14px;
  color: var(--text-dim);
  background: rgba(15, 16, 19, 0.6);
  border: 1px solid var(--line);
  border-radius: 999px;
}

.close:hover {
  color: var(--text);
}

.stage {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1;
  min-width: 0;
  padding: 40px 32px;
  text-align: center;
}

.art {
  width: 248px;
  height: 248px;
  background: var(--panel);
  border-radius: 20px;
  object-fit: cover;
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.06),
    0 24px 60px rgba(0, 0, 0, 0.6),
    0 0 80px -10px var(--pink-glow);
}

.art.placeholder {
  border: 1px dashed var(--line);
}

.title {
  max-width: 560px;
  margin: 24px 0 6px;
  overflow: hidden;
  font-size: 20px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.owner {
  font-size: 13px;
  color: var(--text-dim);
}

.progress {
  display: flex;
  align-items: center;
  gap: 12px;
  width: min(560px, 100%);
  margin-top: 26px;
}

.progress .range {
  flex: 1;
}

.time {
  min-width: 42px;
  font-size: 11px;
  color: var(--text-dim);
}

.controls {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 14px;
}

.icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  color: var(--text);
  border-radius: 50%;
}

.icon-btn svg {
  width: 24px;
  height: 24px;
  fill: currentColor;
}

.icon-btn:hover {
  background: rgba(255, 255, 255, 0.08);
}

.icon-btn.main {
  width: 62px;
  height: 62px;
  color: #1a1014;
  background: linear-gradient(135deg, var(--pink) 0%, #ff5e8a 100%);
  box-shadow: 0 8px 24px var(--pink-glow);
}

.footer {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 22px;
}

.like {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  color: var(--text-dim);
  border-radius: 50%;
}

.like svg {
  width: 18px;
  height: 18px;
  fill: currentColor;
}

.like:hover {
  color: var(--pink);
  background: rgba(255, 255, 255, 0.08);
}

.like.active {
  color: var(--pink);
}

.mode {
  padding: 5px 12px;
  font-size: 12px;
  color: var(--text-dim);
  border: 1px solid var(--line);
  border-radius: 999px;
}

.mode:hover {
  color: var(--pink);
  border-color: var(--pink);
}

.volume-label {
  font-size: 12px;
  color: var(--text-dim);
}

.vol {
  width: 110px;
}

.msg {
  margin: 16px 0 0;
  font-size: 12px;
  color: var(--pink);
}

.msg.error {
  color: #ff8a8a;
}

.queue {
  position: relative;
  display: flex;
  width: 340px;
  min-height: 0;
  padding-top: 32px;
  background: rgba(10, 10, 16, 0.6);
  border-left: 1px solid var(--line-soft);
  backdrop-filter: blur(24px) saturate(1.2);
}
</style>
