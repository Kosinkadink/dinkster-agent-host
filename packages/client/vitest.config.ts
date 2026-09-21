import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Bound concurrent fork startup and shutdown on Windows.
    fileParallelism: false,
  },
})
