export interface WorkflowRun {
  databaseId: number
  name: string
  status: string
  conclusion: string | null
  headBranch: string
  event: string
  url: string
  displayTitle: string
  createdAt: string
  updatedAt: string
}

export interface GhOptions {
  branch?: string
  limit?: number
  workflows?: string[]
}

export type ShellFn = (
  strings: TemplateStringsArray,
  ...expressions: unknown[]
) => { quiet(): { text(): Promise<string> } }

const GH_FIELDS = [
  "databaseId",
  "name",
  "status",
  "conclusion",
  "headBranch",
  "event",
  "url",
  "displayTitle",
  "createdAt",
  "updatedAt",
].join(",")

export async function getCurrentBranch($: ShellFn): Promise<string> {
  try {
    const result = await $`git branch --show-current`.quiet().text()
    return result.trim()
  } catch {
    return ""
  }
}

export async function fetchWorkflowRuns(
  $: ShellFn,
  options: GhOptions = {},
): Promise<WorkflowRun[]> {
  const { branch, limit = 5, workflows } = options

  const currentBranch =
    branch && branch !== "current" ? branch : await getCurrentBranch($)

  if (!currentBranch) return []

  const args = [
    "run",
    "list",
    "--branch",
    currentBranch,
    "--json",
    GH_FIELDS,
    "--limit",
    String(limit),
  ]

  if (workflows?.length) {
    for (const w of workflows) {
      args.push("--workflow", w)
    }
  }

  const result = await $`gh ${args}`.quiet().text()
  const parsed = JSON.parse(result.trim())

  if (!Array.isArray(parsed)) {
    return []
  }

  return parsed as WorkflowRun[]
}

/**
 * Returns only the runs that belong to the same trigger as the newest run.
 * Runs are considered part of the same trigger if their createdAt is within
 * `windowMs` milliseconds of the most recent run's createdAt (default 60 s).
 * This prevents stale runs from older pushes polluting the toast summary.
 */
export function groupRunsByTrigger(runs: WorkflowRun[], windowMs = 60_000): WorkflowRun[] {
  if (runs.length === 0) return []
  const newestTime = new Date(runs[0].createdAt).getTime()
  return runs.filter((r) => newestTime - new Date(r.createdAt).getTime() <= windowMs)
}

export type StatusLevel = "success" | "error" | "warning" | "info"

export function mapStatus(run: WorkflowRun): StatusLevel {
  if (
    run.status === "in_progress" ||
    run.status === "queued" ||
    run.status === "waiting" ||
    run.status === "pending"
  ) {
    return "info"
  }

  switch (run.conclusion) {
    case "success":
      return "success"
    case "failure":
    case "timed_out":
      return "error"
    case "cancelled":
    case "skipped":
    case "stale":
      return "warning"
    default:
      return "info"
  }
}

export function formatStatus(run: WorkflowRun): string {
  if (run.status === "in_progress") return "running"
  if (run.status === "queued") return "queued"
  if (run.status === "waiting") return "waiting"
  if (run.status === "pending") return "pending"
  return run.conclusion ?? run.status
}
