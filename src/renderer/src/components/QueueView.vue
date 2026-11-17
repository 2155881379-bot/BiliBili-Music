<script setup lang="ts">
import { computed, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { usePlayerStore } from '../stores/player'
import { formatTime } from '../utils/format'
import { useVirtualList } from '../composables/useVirtualList'
import CoverImage from './CoverImage.vue'

const player = usePlayerStore()
const props = withDefaults(defineProps<{ active?: boolean }>(), { active: true })
const { listEl, rows, top, bottom, enabled, reveal } = useVirtualList(() => player.queue, { active: () => props.active })

const dragId = ref<string | null>(null)
const dragIndex = computed(() => player.queue.findIndex(track => track.queueId === dragId.value))
const overIndex = ref<number | null>(null)
let dragEndedAt = 0
let edgeFrame = 0
let edgeSpeed = 0
const renderedRows = computed(() => {
  const result = rows.value.map(row => ({ ...row, pinned: false }))
  // The browser requires the original dragged element to survive until dragend.
  const index = dragIndex.value
  if (enabled.value && index >= 0 && !result.some(row => row.index === index)) {
    result.push({ item: player.queue[index], index, pinned: true })
  }
  return result
})

function onClick(index: number): void {
  // 拖拽结束时的 click 不该触发播放
  if (Date.now() - dragEndedAt < 250) return
  player.playAt(index)
}

function onDragStart(index: number, event: DragEvent): void {
  dragId.value = player.queue[index].queueId
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(index))
  }
}

function onDragOver(index: number, event: DragEvent): void {
  event.preventDefault()
  overIndex.value = index
}

function onDrop(index: number): void {
  if (dragIndex.value >= 0) player.move(dragIndex.value, index)
  onDragEnd()
}

function onDragEnd(): void {
  dragEndedAt = Date.now()
  dragId.value = null
  overIndex.value = null
  edgeSpeed = 0
  cancelAnimationFrame(edgeFrame)
  edgeFrame = 0
}

function edgeScroll(): void {
  const list = listEl.value
  if (!list || !edgeSpeed || dragIndex.value < 0 || !enabled.value) { edgeFrame = 0; return }
  list.scrollTop += edgeSpeed
  edgeFrame = requestAnimationFrame(edgeScroll)
}

function onListDragOver(event: DragEvent): void {
  if (dragIndex.value < 0 || !listEl.value) return
  event.preventDefault()
  const rect = listEl.value.getBoundingClientRect()
  if (event.clientY < rect.top || event.clientY > rect.bottom) return
  edgeSpeed = event.clientY < rect.top + 48 ? -14 : event.clientY > rect.bottom - 48 ? 14 : 0
  if (edgeSpeed && !edgeFrame) edgeFrame = requestAnimationFrame(edgeScroll)
  overIndex.value = Math.min(player.queue.length - 1, Math.max(0, Math.floor((event.clientY - rect.top + listEl.value.scrollTop) / 60)))
}

onMounted(() => {
  void reveal(player.currentIndex)
  window.addEventListener('dragend', onDragEnd)
  window.addEventListener('drop', onDragEnd)
})
onDeactivated(onDragEnd)
watch(enabled, active => { if (!active) onDragEnd() })
onBeforeUnmount(() => {
  onDragEnd()
  window.removeEventListener('dragend', onDragEnd)
  window.removeEventListener('drop', onDragEnd)
})
</script>

<template>
  <section class="panel">
    <div class="panel-head">
      <span>共 {{ player.queue.length }} 首</span>
      <span class="spacer" />
      <button class="ghost" :disabled="!player.queue.length" @click="player.clear()">清空队列</button>
    </div>

    <div v-if="!player.queue.length" class="empty">队列还是空的，先去「找歌」里搜几首</div>

    <ul v-else ref="listEl" class="list" @dragover="onListDragOver" @dragleave="edgeSpeed = 0">
      <li class="virtual-spacer" aria-hidden="true" :style="{ height: `${top}px` }" />
      <li
        v-for="{ item: track, index, pinned } in renderedRows"
        :key="track.queueId"
        class="row"
        :style="pinned ? { position: 'fixed', top: '-1000px', left: '-1000px' } : undefined"
        draggable="true"
        :data-index="index"
        :class="{
          active: index === player.currentIndex,
          dragging: dragIndex === index,
          over: overIndex === index && dragIndex !== index
        }"
        @click="onClick(index)"
        @dragstart="onDragStart(index, $event)"
        @dragover="onDragOver(index, $event)"
        @drop.stop.prevent="onDrop(index)"
        @dragend="onDragEnd"
      >
        <span class="row-num">{{ index + 1 }}</span>
        <CoverImage class="cover" :src="track.cover" :size="88" alt="" loading="lazy" />
        <div class="row-main">
          <div class="row-title" :title="track.title">{{ track.title }}</div>
          <div class="row-sub">{{ track.owner }}</div>
        </div>
        <span class="row-time">{{ formatTime(track.duration) }}</span>
        <button class="row-remove" title="从队列移除" @click.stop="player.removeAt(index)">
          ×
        </button>
      </li>
      <li class="virtual-spacer" aria-hidden="true" :style="{ height: `${bottom}px` }" />
    </ul>
  </section>
</template>

<style scoped>
.row {
  cursor: grab;
}

.row.dragging {
  opacity: 0.4;
}

.row.over {
  box-shadow: inset 0 2px 0 var(--pink);
}
</style>
