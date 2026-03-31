export interface WorkflowRun {
  databaseId: number
  name: string
  status: string
  conclusion: string | null
  headBranch: string
  headSha: string
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
  cwd?: string
}

/**
 * Execute a command using Bun.spawn and return its stdout as a string.
 * Works from any context including background timers.
 */
export async function exec(cmd: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new Error(err.trim() || `Command exited with code ${exitCode}`)
  }
  return new Response(proc.stdout).text()
}

/**
 * Indirection object so tests can replace the exec implementation without
 * needing ES module live-binding tricks. All internal callers use _exec.exec.
 */
export const _exec = { exec }

const GH_FIELDS = [
  "databaseId",
  "name",
  "status",
  "conclusion",
  "headBranch",
  "headSha",
  "event",
  "url",
  "displayTitle",
  "createdAt",
  "updatedAt",
].join(",")

export async function getCurrentBranch(cwd?: string): Promise<string> {
  try {
    const result = await _exec.exec(["git", "branch", "--show-current"], cwd)
    return result.trim()
  } catch {
    return ""
  }
}

export async function getHeadCommitSha(cwd?: string): Promise<string> {
  try {
    const result = await _exec.exec(["git", "rev-parse", "HEAD"], cwd)
    return result.trim()
  } catch {
    return ""
  }
}

export async function fetchWorkflowRuns(
  options: GhOptions = {},
): Promise<WorkflowRun[]> {
  const { branch, limit = 5, workflows, cwd } = options

  const currentBranch =
    branch && branch !== "current" ? branch : await getCurrentBranch(cwd)

  if (!currentBranch) return []

  const args = [
    "gh",
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

  const result = await _exec.exec(args, cwd)
  const parsed = JSON.parse(result.trim())

  if (!Array.isArray(parsed)) {
    return []
  }

  return parsed as WorkflowRun[]
}

/**
 * Returns only the runs that belong to the given commit SHA.
 * This ensures we only show runs for the most recent commit.
 */
export function filterRunsByCommit(runs: WorkflowRun[], sha: string): WorkflowRun[] {
  if (!sha || runs.length === 0) return runs
  return runs.filter((r) => r.headSha === sha)
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
