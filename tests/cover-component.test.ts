// @vitest-environment node
import { resolve } from 'node:path'
import { compileScript, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import {
  createRenderer,
  h,
  nextTick,
  provide,
  ref,
  ssrContextKey,
  type App,
  type Component
} from 'vue'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'

interface HostNode {
  type: string
  text: string
  props: Record<string, unknown>
  children: HostNode[]
  parent: HostNode | null
  decode: ReturnType<typeof vi.fn>
}

interface CoverEvents {
  decoded: ReturnType<typeof vi.fn>
  fallback: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
}

const projectRoot = resolve(__dirname, '..')
const originalSource = 'https://i0.hdslb.com/bfs/archive/original.jpg'
const secondSource = 'https://i0.hdslb.com/bfs/archive/second.jpg'

let server: ViteDevServer
let CoverImage: Component

function createNode(type: string, text = ''): HostNode {
  return {
    type,
    text,
    props: {},
    children: [],
    parent: null,
    decode: vi.fn<() => Promise<void>>(() => Promise.resolve())
  }
}

function insertChild(child: HostNode, parent: HostNode, anchor: HostNode | null): void {
  if (child.parent) removeChild(child)
  const index = anchor ? parent.children.indexOf(anchor) : -1
  if (index >= 0) parent.children.splice(index, 0, child)
  else parent.children.push(child)
  child.parent = parent
}

function removeChild(child: HostNode): void {
  if (!child.parent) return
  const index = child.parent.children.indexOf(child)
  if (index >= 0) child.parent.children.splice(index, 1)
  child.parent = null
}

function nextSibling(node: HostNode): HostNode | null {
  if (!node.parent) return null
  const index = node.parent.children.indexOf(node)
  return node.parent.children[index + 1] ?? null
}

const { createApp } = createRenderer<HostNode, HostNode>({
  createElement: createNode,
  createText: (text) => createNode('#text', text),
  createComment: (text) => createNode('#comment', text),
  setText: (node, text) => {
    node.text = text
  },
  setElementText: (node, text) => {
    node.children = []
    if (text) insertChild(createNode('#text', text), node, null)
  },
  insert: insertChild,
  remove: removeChild,
  parentNode: (node) => node.parent,
  nextSibling,
  patchProp: (node, key, _previous, next) => {
    node.props[key] = next
  }
})

function mountCover(
  props: Record<string, unknown>,
  events: CoverEvents
): { root: HostNode; app: App } {
  const root = createNode('#root')
  const app = createApp({
    setup() {
      provide(ssrContextKey, { modules: new Set<string>() })
    },
    render: () =>
      h(CoverImage, {
        ...props,
        onDecoded: events.decoded,
        onFallback: events.fallback,
        onError: events.error
      })
  })
  app.mount(root)
  return { root, app }
}

function imageNode(root: HostNode): HostNode {
  const image = root.children[0]
  if (!image || image.type !== 'img') throw new Error('CoverImage did not render an img')
  return image
}

function dispatch(node: HostNode, event: 'load' | 'error'): void {
  const handler = node.props[`on${event[0].toUpperCase()}${event.slice(1)}`]
  if (typeof handler !== 'function') throw new Error(`No ${event} handler`)
  ;(handler as () => void)()
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

function newEvents(): CoverEvents {
  return {
    decoded: vi.fn(),
    fallback: vi.fn(),
    error: vi.fn()
  }
}

beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: projectRoot,
    appType: 'custom',
    plugins: [
      {
        name: 'cover-component-test-module',
        resolveId(id) {
          if (id === 'virtual:cover-component') return '\0cover-component'
        },
        async load(id) {
          if (id !== '\0cover-component') return
          const filename = resolve(
            projectRoot,
            'src/renderer/src/components/CoverImage.vue'
          )
          const source = await import('node:fs/promises').then(({ readFile }) =>
            readFile(filename, 'utf8')
          )
          const { descriptor, errors } = parse(source, { filename })
          if (errors.length) throw errors[0]
          const compiled = compileScript(descriptor, {
            id: 'cover-component-test',
            inlineTemplate: true,
            templateOptions: {
              compilerOptions: { isTS: true }
            }
          })
          const transformed = await transform(
            compiled.content.replace(
              "'../utils/cover'",
              "'/src/renderer/src/utils/cover.ts'"
            ),
            { loader: 'ts', format: 'esm', target: 'es2022' }
          )
          return transformed.code
        }
      }
    ],
    server: { middlewareMode: true },
    logLevel: 'silent'
  })
  const module = await server.ssrLoadModule('virtual:cover-component')
  CoverImage = module.default as Component
})

afterAll(async () => {
  await server?.close()
})

describe('CoverImage loading behavior', () => {
  it('does not proactively decode when mounted', async () => {
    const events = newEvents()
    const { root, app } = mountCover(
      { src: originalSource, size: 44, dpr: 1 },
      events
    )
    const image = imageNode(root)

    expect(image.decode).not.toHaveBeenCalled()
    await settle()
    app.unmount()
    expect(events.decoded).not.toHaveBeenCalled()
    expect(events.fallback).not.toHaveBeenCalled()
    expect(events.error).not.toHaveBeenCalled()
  })

  it('treats an AbortError from decode after load as cancellation', async () => {
    const events = newEvents()
    const { root, app } = mountCover(
      { src: originalSource, size: 44, dpr: 1 },
      events
    )
    const image = imageNode(root)
    const optimized = image.props.src
    image.decode.mockRejectedValueOnce(
      Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
    )

    dispatch(image, 'load')
    expect(image.decode).toHaveBeenCalledTimes(1)
    await settle()

    expect(image.props.src).toBe(optimized)
    expect(events.decoded).not.toHaveBeenCalled()
    expect(events.fallback).not.toHaveBeenCalled()
    expect(events.error).not.toHaveBeenCalled()
    app.unmount()
  })

  it('falls back to the original only once after image errors', async () => {
    const events = newEvents()
    const { root, app } = mountCover(
      { src: originalSource, size: 44, dpr: 1 },
      events
    )
    const image = imageNode(root)
    expect(image.props.src).not.toBe(originalSource)

    dispatch(image, 'error')
    await nextTick()
    expect(image.props.src).toBe(originalSource)
    expect(events.fallback).toHaveBeenCalledTimes(1)
    expect(events.fallback).toHaveBeenCalledWith(originalSource)

    dispatch(image, 'error')
    await nextTick()
    expect(image.props.src).toBe(originalSource)
    expect(events.fallback).toHaveBeenCalledTimes(1)
    expect(events.error).toHaveBeenCalledTimes(1)
    expect(events.error).toHaveBeenCalledWith(originalSource)
    app.unmount()
  })

  it('ignores a previous src decode that settles after a source change', async () => {
    const events = newEvents()
    const source = ref(originalSource)
    let resolveOld!: () => void
    let resolveNew!: () => void
    const oldDecode = new Promise<void>((resolvePromise) => {
      resolveOld = resolvePromise
    })
    const newDecode = new Promise<void>((resolvePromise) => {
      resolveNew = resolvePromise
    })
    const root = createNode('#root')
    const app = createApp({
      setup() {
        provide(ssrContextKey, { modules: new Set<string>() })
      },
      render: () =>
        h(CoverImage, {
          src: source.value,
          size: 44,
          dpr: 1,
          onDecoded: events.decoded,
          onFallback: events.fallback,
          onError: events.error
        })
    })
    app.mount(root)
    const image = imageNode(root)
    const firstOptimized = image.props.src

    image.decode.mockReturnValueOnce(oldDecode)
    dispatch(image, 'load')
    source.value = secondSource
    await nextTick()
    const secondOptimized = image.props.src
    expect(secondOptimized).not.toBe(firstOptimized)

    image.decode.mockReturnValueOnce(newDecode)
    dispatch(image, 'load')
    resolveOld()
    await settle()
    expect(events.decoded).not.toHaveBeenCalled()

    resolveNew()
    await settle()
    expect(events.decoded).toHaveBeenCalledTimes(1)
    expect(events.decoded).toHaveBeenCalledWith(secondOptimized)
    expect(events.fallback).not.toHaveBeenCalled()
    expect(events.error).not.toHaveBeenCalled()
    app.unmount()
  })
})
