<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { getCoverImageUrl } from '../utils/cover'

defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    src: string
    /** CSS pixels used to choose the CDN image width. */
    size: number
    dpr?: number
  }>(),
  {
    dpr: undefined
  }
)

const emit = defineEmits<{
  decoded: [source: string]
  fallback: [source: string]
  error: [source: string]
}>()

const image = ref<HTMLImageElement | null>(null)
const optimizedSource = computed(() =>
  getCoverImageUrl(props.src, { displayWidth: props.size, dpr: props.dpr })
)
const displayedSource = ref(optimizedSource.value)

let requestId = 0
let fellBack = false
let reportedError = false

async function decodeSource(id: number, source: string): Promise<void> {
  if (!source) return
  if (id !== requestId) return

  const element = image.value
  if (!element || displayedSource.value !== source) return

  try {
    await element.decode()
    if (id === requestId && displayedSource.value === source) emit('decoded', source)
  } catch {
    // A pending decode may be aborted by virtualization or a src change. Only a
    // network/image error should fall back to the potentially very large original.
  }
}

function handleFailure(id: number, failedSource: string): void {
  if (id !== requestId || displayedSource.value !== failedSource) return

  if (!fellBack && failedSource !== props.src) {
    fellBack = true
    displayedSource.value = props.src
    emit('fallback', props.src)
    return
  }

  if (!reportedError) {
    reportedError = true
    emit('error', failedSource)
  }
}

function onImageError(): void {
  handleFailure(requestId, displayedSource.value)
}

watch(
  [optimizedSource, () => props.src],
  () => {
    requestId += 1
    fellBack = false
    reportedError = false
    displayedSource.value = optimizedSource.value
  },
  { immediate: true, flush: 'post' }
)
</script>

<template>
  <img
    ref="image"
    v-bind="$attrs"
    :src="displayedSource"
    decoding="async"
    @load="decodeSource(requestId, displayedSource)"
    @error="onImageError"
  />
</template>
