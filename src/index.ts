import type { PluginModule } from "@opencode-ai/plugin"
import { server } from "./server.js"

const plugin: PluginModule = {
  id: "gh-actions-status",
  server,
}

export default plugin
