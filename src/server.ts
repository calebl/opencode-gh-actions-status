import { tool } from "@opencode-ai/plugin"
import type { Plugin, Hooks, PluginOptions } from "@opencode-ai/plugin"
import {
  fetchWorkflowRuns,
  groupRunsByTrigger,
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
  /**
   * When set, the plugin returns these runs instead of calling `gh`.
   * Each element is a snapshot; the plugin cycles through them on each poll
   * tick so you can simulate in_progress → completed without a real CI run.
   *
   * Example opencode.json entry:
   * ["./dist/index.js", {
   *   "mockRuns": [
   *     [{ "databaseId": 1, "name": "CI", "status": "in_progress", "conclusion": null,
   *        "headBranch": "main", "event": "push", "url": "https://github.com/x/y/runs/1",
   *        "displayTitle": "mock", "createdAt": "2024-01-01T00:00:00Z", "updatedAt": "2024-01-01T00:00:00Z" }],
   *     [{ "databaseId": 1, "name": "CI", "status": "completed", "conclusion": "success",
   *        "headBranch": "main", "event": "push", "url": "https://github.com/x/y/runs/1",
   *        "displayTitle": "mock", "createdAt": "2024-01-01T00:00:00Z", "updatedAt": "2024-01-01T00:01:00Z" }]
   *   ]
   * }]
   */
  mockRuns?: WorkflowRun[][]
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
    mockRuns: Array.isArray(options.mockRuns)
      ? (options.mockRuns as WorkflowRun[][]).filter(Array.isArray)
      : undefined,
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

  // Mock cycle state: index advances on every getRuns() call so each poll tick
  // returns the next snapshot, wrapping at the last one.
  const mockSnapshots = config.mockRuns ?? null
  let mockIndex = 0

  async function getRuns(): Promise<WorkflowRun[]> {
    // Short-circuit to mock data when configured
    if (mockSnapshots !== null) {
      const snapshot = mockSnapshots[Math.min(mockIndex, mockSnapshots.length - 1)]
      mockIndex = Math.min(mockIndex + 1, mockSnapshots.length - 1)
      cachedRuns = snapshot
      return snapshot
    }

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

  // ── Toast lifecycle state ──────────────────────────────────────────────────
  // We poll independently of session.idle so toasts appear as soon as a run
  // starts and are refreshed every 10 s while runs are active.
  //
  // Lifecycle:
  //   • A new run is detected  → show toast immediately, start 10 s polling
  //   • Run still in progress  → refresh toast every 10 s
  //   • Run reaches final state → show final toast with a 30-minute duration
  //   • A brand-new run starts  → dismiss current toast immediately, restart
  //
  // "Dismiss" is achieved by sending a new toast with duration = 1 ms.

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _setInterval: (fn: () => void, ms: number) => unknown = (globalThis as any).setInterval
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _clearInterval: (id: unknown) => void = (globalThis as any).clearInterval

  // ID of the most-recent run we are tracking (databaseId of runs[0])
  let trackedRunId: number | null = null
  // Key of the last toast we sent (variant:summary) – used to skip no-op updates
  let lastToastKey = ""
  // setInterval handle for the active polling loop
  let pollHandle: unknown = null

  function isRunActive(runs: WorkflowRun[]): boolean {
    return groupRunsByTrigger(runs).some(
      (r) =>
        r.status === "in_progress" ||
        r.status === "queued" ||
        r.status === "waiting" ||
        r.status === "pending",
    )
  }

  function buildToastPayload(runs: WorkflowRun[]): {
    variant: "success" | "warning" | "error" | "info"
    summary: string
  } {
    // Only summarise runs from the same trigger as the newest run
    const levels = groupRunsByTrigger(runs).map(mapStatus)
    const variant: "success" | "warning" | "error" | "info" = levels.includes("error")
      ? "error"
      : levels.includes("warning")
        ? "warning"
        : levels.includes("info")
          ? "info"
          : "success"

    const counts = {
      success: levels.filter((l) => l === "success").length,
      error: levels.filter((l) => l === "error").length,
      warning: levels.filter((l) => l === "warning").length,
      info: levels.filter((l) => l === "info").length,
    }
    const parts: string[] = []
    if (counts.info) parts.push(`${counts.info} running`)
    if (counts.success) parts.push(`${counts.success} passing`)
    if (counts.error) parts.push(`${counts.error} failing`)
    if (counts.warning) parts.push(`${counts.warning} cancelled`)
    return { variant, summary: parts.join(" · ") }
  }

  async function sendToast(
    variant: "success" | "warning" | "error" | "info",
    summary: string,
    duration: number,
  ) {
    await client.tui.showToast({
      body: {
        title: "GitHub Actions",
        message: summary,
        variant,
        duration,
      },
    })
  }

  async function dismissToast() {
    // Sending a 1 ms duration effectively dismisses the current toast
    await client.tui.showToast({
      body: {
        title: "GitHub Actions",
        message: "",
        variant: "info",
        duration: 1,
      },
    })
    lastToastKey = ""
  }

  function stopPolling() {
    if (pollHandle !== null) {
      _clearInterval(pollHandle)
      pollHandle = null
    }
  }

  async function tickToast() {
    let runs: WorkflowRun[]
    try {
      // Bypass the cache so we always get fresh data on each tick
      lastFetch = 0
      runs = await getRuns()
    } catch {
      return
    }

    if (runs.length === 0) {
      stopPolling()
      return
    }

    const newestId = runs[0].databaseId
    const isNew = newestId !== trackedRunId

    if (isNew && trackedRunId !== null) {
      // A brand-new run appeared – dismiss the old toast first
      await dismissToast()
    }

    trackedRunId = newestId
    const active = isRunActive(runs)
    const { variant, summary } = buildToastPayload(runs)
    const toastKey = `${variant}:${summary}`

    if (toastKey !== lastToastKey) {
      const duration = active
        ? 10_500 // slightly longer than the poll interval so it stays visible
        : 30 * 60 * 1000 // 30 minutes for a final state
      await sendToast(variant, summary, duration)
      lastToastKey = toastKey
    }

    if (!active) {
      // Run has finished – no need to keep polling
      stopPolling()
    }
  }

  function startPolling() {
    if (pollHandle !== null) return // already running
    // Fire immediately, then repeat every 10 s
    void tickToast()
    pollHandle = _setInterval(() => void tickToast(), 10_000)
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
        // Start polling for runs whenever the session goes idle (i.e. after
        // the agent finishes a turn and might have triggered a CI run).
        startPolling()
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
