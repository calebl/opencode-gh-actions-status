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

/**
 * Returns true if the `gh` CLI is available and authenticated.
 * Returns a string error message if not.
 */
export async function checkGhAvailable(cwd?: string): Promise<true | string> {
  try {
    await _exec.exec(["gh", "--version"], cwd)
    return true
  } catch {
    return "GitHub CLI (gh) is not installed or not in PATH. Install it from https://cli.github.com"
  }
}

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

export interface ReviewComment {
  author: string
  body: string
  createdAt: string
  url: string
}

export interface ReviewThread {
  path: string
  line: number | null
  diffSide: string
  comments: ReviewComment[]
}

/**
 * Returns all unresolved review threads on the PR for the current branch,
 * including the full comment text so agents can read and act on them.
 * Returns an empty array if there is no open PR or the data cannot be fetched.
 */
export async function fetchUnresolvedThreads(cwd?: string): Promise<ReviewThread[]> {
  try {
    // Get current PR number
    const prJson = await _exec.exec(["gh", "pr", "view", "--json", "number"], cwd)
    const { number } = JSON.parse(prJson.trim()) as { number: number }
    if (!number) return []

    // Get repo info (owner/name) from git remote
    const remoteUrl = await _exec.exec(["git", "remote", "get-url", "origin"], cwd)
    const match = remoteUrl.trim().match(/[:/]([^/]+)\/([^/.]+?)(\.git)?$/)
    if (!match) return []
    const [, owner, repo] = match

    // Fetch unresolved review threads with full comment data via GraphQL
    const query = `{
      repository(owner:"${owner}", name:"${repo}") {
        pullRequest(number:${number}) {
          reviewThreads(first:100) {
            nodes {
              isResolved
              path
              line
              diffSide
              comments(first:50) {
                nodes {
                  author { login }
                  body
                  createdAt
                  url
                }
              }
            }
          }
        }
      }
    }`
    const result = await _exec.exec(["gh", "api", "graphql", "-f", `query=${query}`], cwd)
    const data = JSON.parse(result.trim())
    const nodes = data?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []
    return nodes
      .filter((t: { isResolved: boolean }) => !t.isResolved)
      .map((t: {
        path: string
        line: number | null
        diffSide: string
        comments: { nodes: Array<{ author: { login: string }; body: string; createdAt: string; url: string }> }
      }) => ({
        path: t.path,
        line: t.line ?? null,
        diffSide: t.diffSide,
        comments: t.comments.nodes.map((c) => ({
          author: c.author.login,
          body: c.body,
          createdAt: c.createdAt,
          url: c.url,
        })),
      }))
  } catch {
    return []
  }
}

/**
 * Resolves a PR review thread by its node ID.
 * Returns true on success or an error message string on failure.
 *
 * To obtain thread node IDs, call fetchUnresolvedThreadsWithIds which
 * returns threads augmented with their GraphQL node IDs.
 */
export async function resolveThread(threadId: string, cwd?: string): Promise<true | string> {
  try {
    const mutation = `mutation {
      resolveReviewThread(input: { threadId: "${threadId}" }) {
        thread { id isResolved }
      }
    }`
    await _exec.exec(["gh", "api", "graphql", "-f", `query=${mutation}`], cwd)
    return true
  } catch (err) {
    return err instanceof Error ? err.message : "Unknown error resolving thread"
  }
}

/**
 * Like fetchUnresolvedThreads but also returns the GraphQL node `id` for each
 * thread so callers can pass it to resolveThread().
 */
export interface ReviewThreadWithId extends ReviewThread {
  id: string
}

export async function fetchUnresolvedThreadsWithIds(cwd?: string): Promise<ReviewThreadWithId[]> {
  try {
    const prJson = await _exec.exec(["gh", "pr", "view", "--json", "number"], cwd)
    const { number } = JSON.parse(prJson.trim()) as { number: number }
    if (!number) return []

    const remoteUrl = await _exec.exec(["git", "remote", "get-url", "origin"], cwd)
    const match = remoteUrl.trim().match(/[:/]([^/]+)\/([^/.]+?)(\.git)?$/)
    if (!match) return []
    const [, owner, repo] = match

    const query = `{
      repository(owner:"${owner}", name:"${repo}") {
        pullRequest(number:${number}) {
          reviewThreads(first:100) {
            nodes {
              id
              isResolved
              path
              line
              diffSide
              comments(first:50) {
                nodes {
                  author { login }
                  body
                  createdAt
                  url
                }
              }
            }
          }
        }
      }
    }`
    const result = await _exec.exec(["gh", "api", "graphql", "-f", `query=${query}`], cwd)
    const data = JSON.parse(result.trim())
    const nodes = data?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []
    return nodes
      .filter((t: { isResolved: boolean }) => !t.isResolved)
      .map((t: {
        id: string
        path: string
        line: number | null
        diffSide: string
        comments: { nodes: Array<{ author: { login: string }; body: string; createdAt: string; url: string }> }
      }) => ({
        id: t.id,
        path: t.path,
        line: t.line ?? null,
        diffSide: t.diffSide,
        comments: t.comments.nodes.map((c) => ({
          author: c.author.login,
          body: c.body,
          createdAt: c.createdAt,
          url: c.url,
        })),
      }))
  } catch {
    return []
  }
}

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
