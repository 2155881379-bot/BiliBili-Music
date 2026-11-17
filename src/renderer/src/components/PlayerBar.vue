<script setup lang="ts">
import { computed } from 'vue'
import { usePlayerStore } from '../stores/player'
import { formatTime } from '../utils/format'
import CoverImage from './CoverImage.vue'

const player = usePlayerStore()

const emit = defineEmits<{ (e: 'expand'): void }>()

const modeLabel = computed(() => ({ order: '顺序', single: '单曲', shuffle: '随机' })[player.mode])

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
</script>

<template>
  <footer class="player">
    <div class="progress-row">
      <span class="time">{{ formatTime(player.currentTime) }}</span>
      <input
        class="range progress"
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

    <div class="player-main">
      <div class="now" title="展开播放界面" @click="emit('expand')">
        <CoverImage
          v-if="player.current"
          class="now-cover"
          :src="player.current.cover"
          :size="92"
          alt=""
        />
        <div v-else class="now-cover placeholder" />
        <div class="now-text">
          <div class="now-title">{{ player.current?.title ?? '未选择歌曲' }}</div>
          <div class="now-sub" :class="{ error: player.error, notice: player.notice }">
            {{
              player.notice ||
              player.error ||
              (player.loading ? '正在获取音频…' : player.current?.owner || '搜索或导入收藏夹开始播放')
            }}
          </div>
        </div>
      </div>

      <div class="controls">
        <button class="icon-btn" title="上一首" @click="player.prev()">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 5h2v14H7zM19 5v14l-9-7z" />
          </svg>
        </button>
        <button
          class="icon-btn main"
          :title="player.playing ? '暂停' : '播放'"
          @click="player.toggle()"
        >
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

      <div class="right">
        <button class="mode" :title="`播放模式：${modeLabel}`" @click="player.cycleMode()">
          {{ modeLabel }}
        </button>
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
    </div>
  </footer>
</template>

<style scoped>
.player {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 20px 13px;
  background:
    linear-gradient(180deg, rgba(251, 114, 153, 0.06) 0%, transparent 30%),
    var(--panel);
  border-top: 1px solid var(--line-soft);
  box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.35);
  flex-shrink: 0;
}

.progress-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.progress {
  flex: 1;
}

.time {
  font-size: 11px;
  color: var(--text-dim);
  min-width: 42px;
  text-align: center;
}

.player-main {
  display: flex;
  align-items: center;
  gap: 18px;
}

.now {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 320px;
  min-width: 0;
  padding: 2px 6px;
  border-radius: 10px;
  cursor: pointer;
}

.now:hover {
  background: var(--panel-hover);
}

.now:hover .now-title {
  color: var(--pink);
}

.now-cover {
  width: 46px;
  height: 46px;
  background: var(--bg);
  border-radius: 8px;
  object-fit: cover;
  flex-shrink: 0;
}

.now-cover.placeholder {
  border: 1px dashed var(--line);
}

.now-text {
  min-width: 0;
}

.now-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.now-sub {
  overflow: hidden;
  font-size: 12px;
  color: var(--text-dim);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.now-sub.error {
  color: #ff8a8a;
}

.now-sub.notice {
  color: var(--pink);
}

.controls {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 auto;
}

.icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  color: var(--text);
}

.icon-btn svg {
  width: 20px;
  height: 20px;
  fill: currentColor;
}

.icon-btn:hover {
  background: var(--panel-hover);
}

.icon-btn.main {
  width: 46px;
  height: 46px;
  color: #1a1014;
  background: linear-gradient(135deg, var(--pink) 0%, #ff5e8a 100%);
  box-shadow: 0 6px 18px var(--pink-glow);
}

.icon-btn.main:hover {
  filter: brightness(1.08);
}

.right {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 320px;
  justify-content: flex-end;
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
  width: 96px;
}
</style>
