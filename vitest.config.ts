import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 5000,
    hookTimeout: 5000,
    sequence: { seed: 20261117 },
    maxWorkers: 2
  }
})
