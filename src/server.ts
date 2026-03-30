import { tool } from "@opencode-ai/plugin"
import type { Plugin, Hooks, PluginOptions } from "@opencode-ai/plugin"
import {
  fetchWorkflowRuns,
  mapStatus,
  formatStatus,
  type WorkflowRun,
  type GhOptions,
  type ShellFn,
} from "./gh.js"

export interface PluginConfig {
  branch?: string
  limit?: number
  workflows?: string[]
  pollInterval?: number
}

export function parseOptions(options?: PluginOptions): PluginConfig {
  if (!options) return {}
  return {
    branch: typeof options.branch === "string" ? options.branch : undefined,
    limit: typeof options.limit === "number" ? options.limit : undefined,
    workflows: Array.isArray(options.workflows)
      ? options.workflows.filter((w): w is string => typeof w === "string")
      : undefined,
    pollInterval:
      typeof options.pollInterval === "number" ? options.pollInterval : undefined,
  }
}

export const server: Plugin = async (input, options) => {
  const config = parseOptions(options)
  const $ = input.$ as unknown as ShellFn

  const ghOptions: GhOptions = {
    branch: config.branch,
    limit: config.limit ?? 5,
    workflows: config.workflows,
  }

  let cachedRuns: WorkflowRun[] = []
  let lastFetch = 0
  const pollInterval = config.pollInterval ?? 30_000
  let fetchPromise: Promise<WorkflowRun[]> | null = null
  let lastFetchError: string | null = null

  async function getRuns(): Promise<WorkflowRun[]> {
    const now = Date.now()
    if (now - lastFetch > pollInterval) {
      if (!fetchPromise) {
        fetchPromise = fetchWorkflowRuns($, ghOptions)
          .then((runs) => {
            cachedRuns = runs
            lastFetchError = null
            lastFetch = Date.now()
            fetchPromise = null
            return runs
          })
          .catch((err: unknown) => {
            lastFetchError =
              err instanceof Error ? err.message : "Unknown error fetching workflow runs"
            lastFetch = Date.now()
            fetchPromise = null
            return cachedRuns
          })
      }
      return fetchPromise
    }
    return cachedRuns
  }

  const client = input.client

  // Track last toast key to avoid showing the same toast on every idle event
  let lastToastKey = ""

  async function showStatusToast() {
    let runs: WorkflowRun[]
    try {
      runs = await getRuns()
    } catch {
      return
    }

    if (runs.length === 0) return

    const levels = runs.map(mapStatus)
    const hasError = levels.includes("error")
    const hasWarning = levels.includes("warning")
    const hasInfo = levels.includes("info") // in-progress / queued

    const variant: "success" | "warning" | "error" | "info" = hasError
      ? "error"
      : hasWarning
        ? "warning"
        : hasInfo
          ? "info"
          : "success"

    // Build a short summary, e.g. "2 passing · 1 failing"
    const counts = {
      success: levels.filter((l) => l === "success").length,
      error: levels.filter((l) => l === "error").length,
      warning: levels.filter((l) => l === "warning").length,
      info: levels.filter((l) => l === "info").length,
    }
    const parts: string[] = []
    if (counts.success) parts.push(`${counts.success} passing`)
    if (counts.error) parts.push(`${counts.error} failing`)
    if (counts.warning) parts.push(`${counts.warning} cancelled`)
    if (counts.info) parts.push(`${counts.info} running`)
    const summary = parts.join(" · ")

    // Deduplicate: skip if nothing changed since last toast
    const toastKey = `${variant}:${summary}`
    if (toastKey === lastToastKey) return
    lastToastKey = toastKey

    await client.tui.showToast({
      body: {
        title: "GitHub Actions",
        message: summary,
        variant,
        duration: 6000,
      },
    })
  }

  // The sidebar hook is supported at runtime but not yet in the published
  // @opencode-ai/plugin type definitions (see sst/opencode#5971).
  interface SidebarPanelItem {
    label: string
    value?: string
    status?: "success" | "warning" | "error" | "info"
  }

  interface SidebarPanel {
    id: string
    title: string
    items: SidebarPanelItem[] | (() => Promise<SidebarPanelItem[]>)
  }

  interface HooksWithSidebar extends Hooks {
    sidebar?: SidebarPanel[]
  }

  const hooks: HooksWithSidebar = {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        await showStatusToast()
      }
    },

    sidebar: [
      {
        id: "gh-actions",
        title: "GitHub Actions",
        items: async () => {
          const runs = await getRuns()
          if (lastFetchError) {
            return [{ label: `Error: ${lastFetchError}`, status: "error" as const }]
          }
          if (runs.length === 0) {
            return [{ label: "No workflow runs found" }]
          }
          return runs.map((run) => ({
            label: run.name,
            value: formatStatus(run),
            status: mapStatus(run),
          }))
        },
      },
    ],

    tool: {
      gh_actions: tool({
        description:
          "Check GitHub Actions workflow run statuses for the current branch. " +
          "Returns the latest workflow runs with their name, status, conclusion, and URL.",
        args: {
          branch: tool.schema
            .string()
            .optional()
            .describe(
              'Branch to check. Defaults to the current git branch. Use "current" for the current branch.',
            ),
          limit: tool.schema
            .number()
            .optional()
            .describe("Maximum number of runs to return (default: 5)"),
        },
        async execute(args) {
          let runs: WorkflowRun[]
          try {
            runs = await fetchWorkflowRuns($, {
              branch: args.branch ?? ghOptions.branch,
              limit: args.limit ?? ghOptions.limit,
              workflows: ghOptions.workflows,
            })
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : "Unknown error"
            return `Failed to fetch workflow runs: ${message}`
          }

          if (runs.length === 0) {
            return "No workflow runs found for the current branch."
          }

          const lines = runs.map((run) => {
            const status = formatStatus(run)
            const level = mapStatus(run)
            const icon =
              level === "success" ? "✓" : level === "error" ? "✗" : level === "warning" ? "⚠" : "●"
            return `${icon} ${run.name}: ${status} (${run.displayTitle})\n  ${run.url}`
          })

          return lines.join("\n\n")
        },
      }),
    },
  }

  return hooks
}
