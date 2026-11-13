import type { Plugin } from "@opencode/plugin"
import { setupOpenMind } from "./src/adapters/opencode/adapter.ts"

const openMind = {
  id: "open-mind",
  async setup(ctx) {
    await setupOpenMind(ctx)
  },
} satisfies Plugin.Plugin

export default openMind
