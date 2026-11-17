import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { StateStore } from '../src/main/state-store'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: vi.fn(actual.writeFile) }
})

it('waits for updates arriving after a write starts, before their debounce fires', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-state-race-'))
  const file = join(dir, 'state.json')
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const { writeFile: write } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const spy = vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
    entered()
    await held
    return write(...args)
  })
  try {
    const store = new StateStore(file, { debounceMs: 400 })
    store.setPlayerState({ queue: [], currentIndex: -1, mode: 'order', volume: .5 })
    let completed = false
    const flushed = store.flushState().then(() => { completed = true })
    await started
    store.savePlayback({ currentIndex: -1, mode: 'order', volume: .2, currentTime: 42 })
    await Promise.resolve()
    expect(completed).toBe(false)
    release()
    await flushed
    expect(JSON.parse(readFileSync(file, 'utf8')).player.currentTime).toBe(42)
  } finally {
    release()
    spy.mockRestore()
    // This directory was created by this test only.
    rmSync(dir, { recursive: true, force: true })
  }
})
