import { tool } from "@opencode-ai/plugin"
import type { Plugin, Hooks, PluginOptions } from "@opencode-ai/plugin"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  checkGhAvailable,
  fetchWorkflowRuns,
  fetchUnresolvedThreadsWithIds,
  resolveThread,
  filterRunsByCommit,
  getHeadCommitSha,
  mapStatus,
  formatStatus,
  type WorkflowRun,
  type ReviewThread,
  type ReviewThreadWithId,
  type GhOptions,
} from "./gh.js"

export interface PluginConfig {
  branch?: string
  limit?: number
  workflows?: string[]
  /** Cache TTL (ms) for workflow run results returned by the sidebar. Default: 60 000 */
  pollInterval?: number
  /** How often (ms) the toast-poll loop fires while CI runs are active after a push. Default: 30 000 */
  toastInterval?: number
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
    toastInterval:
      typeof options.toastInterval === "number" ? options.toastInterval : undefined,
    mockRuns: Array.isArray(options.mockRuns)
      ? (options.mockRuns as WorkflowRun[][]).filter(Array.isArray)
      : undefined,
  }
}

/**
 * Resolve the path to the bundled skills directory shipped with this plugin.
 * Works both in source (src/) and compiled (dist/) layouts.
 */
function getSkillsDir(): string {
  // import.meta.url points to the current file; skills/ lives at the package root.
  const thisDir = dirname(fileURLToPath(import.meta.url))
  // From src/ or dist/, go up one level to the package root.
  return resolve(thisDir, "..", "skills")
}

/**
 * Format workflow runs and review threads into a readable report.
 * Shared between the gh_actions tool and the post-push prompt.
 */
export function formatRunResults(runs: WorkflowRun[], threads: ReviewThread[] | ReviewThreadWithId[]): string {
  if (runs.length === 0) {
    return "No workflow runs found for the current commit."
  }

  const lines = runs.map((run) => {
    const status = formatStatus(run)
    const level = mapStatus(run)
    const icon =
      level === "success" ? "✓" : level === "error" ? "✗" : level === "warning" ? "⚠" : "●"
    return `${icon} ${run.name}: ${status} (${run.displayTitle})\n  ${run.url}`
  })

  const output: string[] = ["## Workflow Runs", lines.join("\n\n")]

  if (threads.length > 0) {
    output.push(`\n## Unresolved Review Comments (${threads.length})`)
    const hasIds = "id" in threads[0]
    if (hasIds) {
      output.push("Use the `resolve_comment` tool with the thread ID to mark a thread as resolved.")
    }
    for (const thread of threads) {
      const location = thread.line
        ? `${thread.path}:${thread.line}`
        : thread.path
      const heading = hasIds ? `\n### ${location} (thread ID: ${"id" in thread ? thread.id : ""})` : `\n### ${location}`
      output.push(heading)
      for (const comment of thread.comments) {
        output.push(`**${comment.author}** (${comment.createdAt}):\n${comment.body}\n${comment.url}`)
      }
    }
  }

  return output.join("\n")
}

// Short reminder injected into every system prompt via experimental.chat.system.transform.
// This is intentionally brief — the full usage guidance lives in skills/gh-actions/SKILL.md
// which OpenCode loads when needed. The purpose here is only to ensure the agent never
// loses awareness of the tool after context compaction discards earlier messages.
const SKILLS_SYSTEM_PROMPT =
  "The gh-actions-status plugin provides a `gh_actions` tool. " +
  "Use it to check GitHub Actions workflow run statuses and unresolved PR review comments " +
  "for the current branch. Call it after pushing code, when asked about CI status, " +
  "or before creating a pull request."

export const server: Plugin = async (input, options) => {
  const config = parseOptions(options)
  const cwd = input.directory as string | undefined

  // Verify gh CLI is available before doing anything else
  const mockSnapshots = Array.isArray(config.mockRuns) ? config.mockRuns : null
  if (mockSnapshots === null) {
    const ghCheck = await checkGhAvailable(cwd)
    if (ghCheck !== true) {
      const client = input.client
      // Show a persistent error toast — sidebar is not a supported API so we
      // rely solely on the toast to surface the error to the user.
      void (client.tui as unknown as { showToast: (args: { body: { title: string; message: string; variant: string; duration: number } }) => Promise<void> })
        .showToast({ body: { title: "GitHub Actions", message: ghCheck, variant: "error", duration: 30 * 60 * 1000 } })
      // Return an empty no-op hooks object
      return {} as ReturnType<Plugin>
    }
  }

  const ghOptions: GhOptions = {
    branch: config.branch,
    limit: config.limit ?? 5,
    workflows: config.workflows,
    cwd,
  }

  let cachedRuns: WorkflowRun[] = []
  let lastFetch = 0
  const pollInterval = config.pollInterval ?? 60_000
  // How often the toast-poll loop fires while CI runs are active after a push
  const toastInterval = config.toastInterval ?? 30_000
  let fetchPromise: Promise<WorkflowRun[]> | null = null
  let lastFetchError: string | null = null

  // Mock cycle state: index advances on every getRuns() call so each poll tick
  // returns the next snapshot, wrapping at the last one.
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
  // Session IDs that triggered a git push — when non-empty, the plugin will
  // prompt each session with CI results once runs reach a final state.
  // Using a Set so multiple rapid pushes from different sessions are all tracked
  // and never silently overwrite each other.
  const pendingPushSessionIDs = new Set<string>()
  // Runs from the last completed poll cycle — used to immediately prompt a
  // session if CI has already finished by the time tool.execute.after fires.
  let lastCompletedRuns: WorkflowRun[] = []

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

  /**
   * After a detected git push, prompt the originating session with the final
   * CI results so the agent can act on failures or review comments.
   */
  async function promptSessionWithResults(sessionID: string, commitRuns: WorkflowRun[]) {
    const threads = mockSnapshots === null ? await fetchUnresolvedThreadsWithIds(cwd) : []
    const text = formatRunResults(commitRuns, threads)
    try {
      // The client exposes session.prompt() at runtime (SDK v2) but the
      // published @opencode-ai/plugin types may not surface it yet.
      const session = (client as unknown as {
        session: { prompt: (args: Record<string, unknown>) => Promise<unknown> }
      }).session
      await session.prompt({
        sessionID,
        parts: [{ type: "text", text, synthetic: true }],
      })
    } catch {
      // Session may have been closed or agent may be busy — silently skip.
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
      ? await fetchUnresolvedThreadsWithIds(cwd).then((t: ReviewThreadWithId[]) => t.length)
      : 0
    const { variant, summary } = buildToastPayload(commitRuns, unresolvedCount)
    const toastKey = `${variant}:${summary}`

    if (toastKey !== lastToastKey) {
      const duration = active
        ? 30_000 // 30 s minimum so toast stays visible between state changes
        : 30 * 60 * 1000 // 30 minutes for a final state
      await sendToast(variant, summary, duration)
      lastToastKey = toastKey
    }

    if (!active) {
      // Run has finished – no need to keep polling
      stopPolling()
      // Stash runs so tool.execute.after can use them if the push hook fires late.
      lastCompletedRuns = commitRuns
      // Prompt any sessions that were waiting for CI results.
      if (pendingPushSessionIDs.size > 0) {
        const sids = [...pendingPushSessionIDs]
        pendingPushSessionIDs.clear()
        for (const sid of sids) {
          void promptSessionWithResults(sid, commitRuns)
        }
      }
    }
  }

  function startPolling() {
    if (pollHandle !== null) return // already running
    // Fire immediately, then repeat on the configured toast interval (default 30 s)
    void tickToast()
    pollHandle = _setInterval(() => void tickToast(), toastInterval)
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

  const skillsDir = getSkillsDir()

  const hooks: HooksWithSidebar = {
    config: async (config) => {
      // Register the bundled skills directory so OpenCode discovers the SKILL.md.
      // The skills property exists at runtime (SDK v2) but may be absent from the
      // type definitions shipped with the current @opencode-ai/plugin version.
      const cfg = config as typeof config & { skills?: { paths?: string[]; urls?: string[] } }
      if (!cfg.skills) cfg.skills = {}
      if (!cfg.skills.paths) cfg.skills.paths = []
      if (!cfg.skills.paths.includes(skillsDir)) {
        cfg.skills.paths.push(skillsDir)
      }
    },

    // Inject skill awareness into the system prompt on every LLM call so the
    // agent always knows the gh_actions tool is available — even after context
    // compaction discards earlier messages.
    "experimental.chat.system.transform": async (_input, output) => {
      if (!output.system.includes(SKILLS_SYSTEM_PROMPT)) {
        output.system.push(SKILLS_SYSTEM_PROMPT)
      }
    },

    // Ensure the compaction summary preserves awareness of the gh_actions skill.
    "experimental.session.compacting": async (_input, output) => {
      const compactionContext =
        "The gh-actions-status plugin is active. The agent has access to a `gh_actions` tool " +
        "for checking GitHub Actions workflow statuses and unresolved PR review comments."
      if (!output.context.includes(compactionContext)) {
        output.context.push(compactionContext)
      }
    },

    // Detect agent-initiated git push commands. On push:
    //  1. Show an immediate "Waiting for CI..." toast
    //  2. Reset tracking so the next run is treated as fresh
    //  3. Start polling — stops automatically when the run reaches a final state
    "tool.execute.after": async (input, _output) => {
      const args = typeof input.args === "string"
        ? input.args
        : JSON.stringify(input.args ?? "")
      if (/\bgit\s+push\b/.test(args)) {
        pendingPushSessionIDs.add(input.sessionID)
        // Reset tracking so the upcoming run's toast is not suppressed
        trackedRunId = null
        lastToastKey = ""
        lastCompletedRuns = []
        // Show an immediate placeholder toast while GitHub queues the run
        if (mockSnapshots === null) {
          void sendToast("info", "Waiting for CI...", 30_000)
          lastToastKey = "info:waiting"
        }
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

          const headSha = await getHeadCommitSha(cwd)
          const commitRuns = headSha ? filterRunsByCommit(runs, headSha) : runs
          const threads = await fetchUnresolvedThreadsWithIds(cwd)
          return formatRunResults(commitRuns, threads)
        },
      }),

      resolve_comment: tool({
        description:
          "Resolve one or more unresolved PR review threads by their thread ID. " +
          "Use gh_actions first to list unresolved threads and obtain their IDs, " +
          "then call this tool with the thread ID(s) to mark them as resolved on GitHub.",
        args: {
          threadIds: tool.schema
            .array(tool.schema.string())
            .describe(
              "Array of GraphQL review thread node IDs to resolve. " +
              "Obtain these by calling gh_actions which returns thread IDs " +
              "alongside the unresolved comment text.",
            ),
        },
        async execute(args) {
          if (!args.threadIds || args.threadIds.length === 0) {
            return "No thread IDs provided. Pass one or more thread node IDs to resolve."
          }

          const results: string[] = []
          for (const threadId of args.threadIds) {
            const outcome = await resolveThread(threadId, cwd)
            if (outcome === true) {
              results.push(`✓ Resolved thread ${threadId}`)
            } else {
              results.push(`✗ Failed to resolve thread ${threadId}: ${outcome}`)
            }
          }
          return results.join("\n")
        },
      }),
    },
  }

  return hooks
}
