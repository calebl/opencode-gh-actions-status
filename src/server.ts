import { tool } from "@opencode-ai/plugin"
import type { Plugin, Hooks, PluginOptions } from "@opencode-ai/plugin"
import {
  fetchWorkflowRuns,
  fetchUnresolvedThreads,
  filterRunsByCommit,
  getHeadCommitSha,
  mapStatus,
  formatStatus,
  type WorkflowRun,
  type ReviewThread,
  type GhOptions,
} from "./gh.js"

export interface PluginConfig {
  branch?: string
  limit?: number
  workflows?: string[]
  pollInterval?: number
  watchInterval?: number
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
    watchInterval:
      typeof options.watchInterval === "number" ? options.watchInterval : undefined,
    mockRuns: Array.isArray(options.mockRuns)
      ? (options.mockRuns as WorkflowRun[][]).filter(Array.isArray)
      : undefined,
  }
}

export const server: Plugin = async (input, options) => {
  const config = parseOptions(options)
  const cwd = input.directory as string | undefined

  const ghOptions: GhOptions = {
    branch: config.branch,
    limit: config.limit ?? 5,
    workflows: config.workflows,
    cwd,
  }

  let cachedRuns: WorkflowRun[] = []
  let lastFetch = 0
  const pollInterval = config.pollInterval ?? 30_000
  // How often the background watcher checks for new runs (independent of cache TTL)
  const watchInterval = config.watchInterval ?? 5_000
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
        fetchPromise = fetchWorkflowRuns(ghOptions)
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

  /**
   * Lightweight peek used by the watcher: returns runs without advancing the
   * mock index. In real mode it always fetches fresh data (bypassing the cache)
   * so the watcher can detect new runs as soon as they appear on GitHub, without
   * waiting for the pollInterval cache TTL to expire.
   */
  async function peekRuns(): Promise<WorkflowRun[]> {
    if (mockSnapshots !== null) {
      // In mock mode return the current snapshot without advancing the index
      return mockSnapshots[Math.min(mockIndex, mockSnapshots.length - 1)]
    }
    // Bypass the cache so each watcher tick gets fresh data
    return fetchWorkflowRuns(ghOptions)
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
  // setInterval handle for the active polling loop (fast, 10 s)
  let pollHandle: unknown = null
  // setInterval handle for the background watcher (slow, 5 s)
  // Watches for new runs that appear from pushes made outside of OpenCode.
  let watchHandle: unknown = null
  // Last HEAD SHA seen by the watcher — used to detect new pushes immediately
  let lastSeenSha = ""

  function isRunActive(runs: WorkflowRun[]): boolean {
    return runs.some(
      (r) =>
        r.status === "in_progress" ||
        r.status === "queued" ||
        r.status === "waiting" ||
        r.status === "pending",
    )
  }

  function buildToastPayload(
    runs: WorkflowRun[],
    unresolvedCount = 0,
  ): {
    variant: "success" | "warning" | "error" | "info"
    summary: string
  } {
    // runs is already filtered to the current HEAD commit
    const levels = runs.map(mapStatus)
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
    if (unresolvedCount > 0) parts.push(`${unresolvedCount} unresolved`)
    return { variant, summary: parts.join("\n") }
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

    // Filter to only runs for the current HEAD commit (skip in mock mode)
    let commitRuns = runs
    if (mockSnapshots === null) {
      const headSha = await getHeadCommitSha(cwd)
      if (headSha) commitRuns = filterRunsByCommit(runs, headSha)
    }

    if (commitRuns.length === 0) {
      stopPolling()
      return
    }

    const newestId = commitRuns[0].databaseId
    const isNew = newestId !== trackedRunId

    if (isNew && trackedRunId !== null) {
      // A brand-new run appeared – dismiss the old toast first
      await dismissToast()
    }

    trackedRunId = newestId
    const active = isRunActive(commitRuns)
    const unresolvedCount = mockSnapshots === null
      ? await fetchUnresolvedThreads(cwd).then((t) => t.length)
      : 0
    const { variant, summary } = buildToastPayload(commitRuns, unresolvedCount)
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

  /**
   * Background watcher: runs on watchInterval (default 5 s) from plugin init.
   *
   * Two responsibilities:
   * 1. Detect a new push immediately (HEAD SHA changed) and show a
   *    "Waiting for CI..." toast before GitHub has even queued the run.
   * 2. Once the run appears in gh run list, hand off to the fast poll loop.
   */
  async function watchTick() {
    // If the fast poll loop is already running, nothing to do
    if (pollHandle !== null) return

    if (mockSnapshots === null) {
      const headSha = await getHeadCommitSha(cwd)
      if (!headSha) return

      // New push detected — show a pending toast immediately
      if (headSha !== lastSeenSha) {
        lastSeenSha = headSha
        // Reset tracking so we don't suppress the upcoming run's toast
        trackedRunId = null
        lastToastKey = ""
        const waitingKey = "info:waiting"
        if (lastToastKey !== waitingKey) {
          await sendToast("info", "Waiting for CI...", 10_500)
          lastToastKey = waitingKey
        }
      }

      // Check if a run has appeared for this HEAD commit
      let runs: WorkflowRun[]
      try {
        runs = await peekRuns()
      } catch {
        return
      }

      const commitRuns = filterRunsByCommit(runs, headSha)
      if (commitRuns.length === 0) return

      // If we already reported a final result for this run, don't re-trigger
      const newestId = commitRuns[0].databaseId
      if (newestId === trackedRunId && lastToastKey !== "" && lastToastKey !== "info:waiting") return

      // Run has appeared — hand off to the fast poll loop
      startPolling()
    } else {
      // Mock mode: no SHA tracking, just check for runs
      let runs: WorkflowRun[]
      try {
        runs = await peekRuns()
      } catch {
        return
      }
      if (runs.length === 0) return
      const newestId = runs[0].databaseId
      if (newestId === trackedRunId && lastToastKey !== "") return
      startPolling()
    }
  }

  function startWatcher() {
    if (watchHandle !== null) return // already running
    // Fire once immediately, then repeat on the watch interval
    void watchTick()
    watchHandle = _setInterval(() => void watchTick(), watchInterval)
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

  // Start the background watcher immediately on plugin init so that pushes
  // made outside of OpenCode (no session.idle) are still detected.
  startWatcher()

  const hooks: HooksWithSidebar = {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        // After an agent turn, skip the watcher delay and poll immediately.
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
          const headSha = await getHeadCommitSha(cwd)
          const commitRuns = headSha ? filterRunsByCommit(runs, headSha) : runs
          if (commitRuns.length === 0) {
            return [{ label: "No workflow runs found for current commit" }]
          }
          return commitRuns.map((run) => ({
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
          "Check GitHub Actions workflow run statuses and unresolved PR review comments " +
          "for the current branch. Returns workflow runs with their status and URL, plus " +
          "full text of any unresolved review threads so you can read and address them.",
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
            runs = await fetchWorkflowRuns({
              branch: args.branch ?? ghOptions.branch,
              limit: args.limit ?? ghOptions.limit,
              workflows: ghOptions.workflows,
              cwd,
            })
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : "Unknown error"
            return `Failed to fetch workflow runs: ${message}`
          }

          // Filter to only runs for the current HEAD commit
          const headSha = await getHeadCommitSha(cwd)
          const commitRuns = headSha ? filterRunsByCommit(runs, headSha) : runs

          if (commitRuns.length === 0) {
            return "No workflow runs found for the current commit."
          }

          const lines = commitRuns.map((run) => {
            const status = formatStatus(run)
            const level = mapStatus(run)
            const icon =
              level === "success" ? "✓" : level === "error" ? "✗" : level === "warning" ? "⚠" : "●"
            return `${icon} ${run.name}: ${status} (${run.displayTitle})\n  ${run.url}`
          })

          const output: string[] = ["## Workflow Runs", lines.join("\n\n")]

          // Fetch unresolved PR review threads
          const threads = await fetchUnresolvedThreads(cwd)
          if (threads.length > 0) {
            output.push(`\n## Unresolved Review Comments (${threads.length})`)
            for (const thread of threads) {
              const location = thread.line
                ? `${thread.path}:${thread.line}`
                : thread.path
              output.push(`\n### ${location}`)
              for (const comment of thread.comments) {
                output.push(`**${comment.author}** (${comment.createdAt}):\n${comment.body}\n${comment.url}`)
              }
            }
          }

          return output.join("\n")
        },
      }),
    },
  }

  return hooks
}
