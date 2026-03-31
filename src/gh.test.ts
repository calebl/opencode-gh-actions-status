import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  _exec,
  checkGhAvailable,
  mapStatus,
  formatStatus,
  getCurrentBranch,
  getHeadCommitSha,
  fetchWorkflowRuns,
  fetchUnresolvedThreads,
  fetchUnresolvedThreadsWithIds,
  resolveThread,
  filterRunsByCommit,
  type WorkflowRun,
} from "./gh.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    databaseId: 1,
    name: "CI",
    status: "completed",
    conclusion: "success",
    headBranch: "main",
    headSha: "abc123",
    event: "push",
    url: "https://github.com/owner/repo/actions/runs/1",
    displayTitle: "test commit",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:01:00Z",
    ...overrides,
  }
}

let execSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.restoreAllMocks()
  execSpy = vi.spyOn(_exec, "exec")
})

// ---------------------------------------------------------------------------
// mapStatus
// ---------------------------------------------------------------------------

describe("mapStatus", () => {
  it("returns 'info' for in_progress", () => {
    expect(mapStatus(makeRun({ status: "in_progress", conclusion: null }))).toBe("info")
  })

  it("returns 'info' for queued", () => {
    expect(mapStatus(makeRun({ status: "queued", conclusion: null }))).toBe("info")
  })

  it("returns 'info' for waiting", () => {
    expect(mapStatus(makeRun({ status: "waiting", conclusion: null }))).toBe("info")
  })

  it("returns 'info' for pending", () => {
    expect(mapStatus(makeRun({ status: "pending", conclusion: null }))).toBe("info")
  })

  it("returns 'success' for completed/success", () => {
    expect(mapStatus(makeRun({ status: "completed", conclusion: "success" }))).toBe("success")
  })

  it("returns 'error' for completed/failure", () => {
    expect(mapStatus(makeRun({ status: "completed", conclusion: "failure" }))).toBe("error")
  })

  it("returns 'error' for completed/timed_out", () => {
    expect(mapStatus(makeRun({ status: "completed", conclusion: "timed_out" }))).toBe("error")
  })

  it("returns 'warning' for completed/cancelled", () => {
    expect(mapStatus(makeRun({ status: "completed", conclusion: "cancelled" }))).toBe("warning")
  })

  it("returns 'warning' for completed/skipped", () => {
    expect(mapStatus(makeRun({ status: "completed", conclusion: "skipped" }))).toBe("warning")
  })

  it("returns 'warning' for completed/stale", () => {
    expect(mapStatus(makeRun({ status: "completed", conclusion: "stale" }))).toBe("warning")
  })

  it("returns 'info' for unknown conclusion", () => {
    expect(mapStatus(makeRun({ status: "completed", conclusion: null }))).toBe("info")
  })
})

// ---------------------------------------------------------------------------
// formatStatus
// ---------------------------------------------------------------------------

describe("formatStatus", () => {
  it("returns 'running' for in_progress", () => {
    expect(formatStatus(makeRun({ status: "in_progress" }))).toBe("running")
  })

  it("returns 'queued' for queued", () => {
    expect(formatStatus(makeRun({ status: "queued" }))).toBe("queued")
  })

  it("returns 'waiting' for waiting", () => {
    expect(formatStatus(makeRun({ status: "waiting" }))).toBe("waiting")
  })

  it("returns 'pending' for pending", () => {
    expect(formatStatus(makeRun({ status: "pending" }))).toBe("pending")
  })

  it("returns conclusion when status is completed", () => {
    expect(formatStatus(makeRun({ status: "completed", conclusion: "success" }))).toBe("success")
    expect(formatStatus(makeRun({ status: "completed", conclusion: "failure" }))).toBe("failure")
    expect(formatStatus(makeRun({ status: "completed", conclusion: "cancelled" }))).toBe("cancelled")
  })

  it("falls back to status when conclusion is null", () => {
    expect(formatStatus(makeRun({ status: "completed", conclusion: null }))).toBe("completed")
  })
})

// ---------------------------------------------------------------------------
// checkGhAvailable
// ---------------------------------------------------------------------------

describe("checkGhAvailable", () => {
  it("returns true when gh is available", async () => {
    execSpy.mockResolvedValue("gh version 2.40.0\n")
    expect(await checkGhAvailable()).toBe(true)
  })

  it("returns an error string when gh is not found", async () => {
    execSpy.mockRejectedValue(new Error("spawn gh ENOENT"))
    const result = await checkGhAvailable()
    expect(result).not.toBe(true)
    expect(result).toContain("gh")
  })
})

// ---------------------------------------------------------------------------
// getCurrentBranch
// ---------------------------------------------------------------------------

describe("getCurrentBranch", () => {
  it("returns trimmed branch name", async () => {
    execSpy.mockResolvedValue("  feature/my-branch\n")
    expect(await getCurrentBranch()).toBe("feature/my-branch")
  })

  it("returns empty string when exec throws", async () => {
    execSpy.mockRejectedValue(new Error("not a git repo"))
    expect(await getCurrentBranch()).toBe("")
  })
})

// ---------------------------------------------------------------------------
// getHeadCommitSha
// ---------------------------------------------------------------------------

describe("getHeadCommitSha", () => {
  it("returns trimmed commit SHA", async () => {
    execSpy.mockResolvedValue("  abc123def456\n")
    expect(await getHeadCommitSha()).toBe("abc123def456")
  })

  it("returns empty string when exec throws", async () => {
    execSpy.mockRejectedValue(new Error("not a git repo"))
    expect(await getHeadCommitSha()).toBe("")
  })
})

// ---------------------------------------------------------------------------
// fetchWorkflowRuns
// ---------------------------------------------------------------------------

describe("fetchWorkflowRuns", () => {
  it("returns parsed runs for the current branch", async () => {
    const runs: WorkflowRun[] = [makeRun({ name: "CI" }), makeRun({ name: "Deploy" })]
    execSpy
      .mockResolvedValueOnce("main\n")
      .mockResolvedValueOnce(JSON.stringify(runs))

    const result = await fetchWorkflowRuns({})
    expect(result).toHaveLength(2)
    expect(result[0].name).toBe("CI")
    expect(result[1].name).toBe("Deploy")
  })

  it("uses the provided branch instead of current branch", async () => {
    const runs: WorkflowRun[] = [makeRun()]
    execSpy.mockResolvedValueOnce(JSON.stringify(runs))

    const result = await fetchWorkflowRuns({ branch: "release/1.0" })
    expect(execSpy).toHaveBeenCalledTimes(1)
    expect(result).toHaveLength(1)
  })

  it("returns empty array when current branch cannot be determined", async () => {
    execSpy.mockResolvedValueOnce("")
    const result = await fetchWorkflowRuns({})
    expect(result).toEqual([])
  })

  it("returns empty array when gh returns non-array JSON", async () => {
    execSpy
      .mockResolvedValueOnce("main\n")
      .mockResolvedValueOnce(JSON.stringify({ error: "oops" }))

    const result = await fetchWorkflowRuns({})
    expect(result).toEqual([])
  })

  it("respects the limit option", async () => {
    const runs = Array.from({ length: 3 }, (_, i) => makeRun({ name: `Run ${i}` }))
    execSpy
      .mockResolvedValueOnce("main\n")
      .mockResolvedValueOnce(JSON.stringify(runs))

    const result = await fetchWorkflowRuns({ limit: 3 })
    expect(result).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// fetchUnresolvedThreads
// ---------------------------------------------------------------------------

describe("fetchUnresolvedThreads", () => {
  const prResponse = JSON.stringify({ number: 42 })
  const remoteUrl = "git@github.com:owner/repo.git\n"
  const makeGraphqlResponse = (threads: Array<{ isResolved: boolean; path: string; line: number | null; diffSide: string; comments: { nodes: Array<{ author: { login: string }; body: string; createdAt: string; url: string }> } }>) =>
    JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: threads } } } } })

  it("returns unresolved threads with full comment data", async () => {
    const thread = {
      isResolved: false,
      path: "src/foo.ts",
      line: 10,
      diffSide: "RIGHT",
      comments: {
        nodes: [{
          author: { login: "alice" },
          body: "Please fix this",
          createdAt: "2024-01-01T00:00:00Z",
          url: "https://github.com/owner/repo/pull/42#discussion_r1",
        }],
      },
    }
    execSpy
      .mockResolvedValueOnce(prResponse)
      .mockResolvedValueOnce(remoteUrl)
      .mockResolvedValueOnce(makeGraphqlResponse([thread]))

    const result = await fetchUnresolvedThreads()
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe("src/foo.ts")
    expect(result[0].line).toBe(10)
    expect(result[0].comments[0].author).toBe("alice")
    expect(result[0].comments[0].body).toBe("Please fix this")
  })

  it("filters out resolved threads", async () => {
    const threads = [
      { isResolved: false, path: "a.ts", line: 1, diffSide: "RIGHT", comments: { nodes: [{ author: { login: "a" }, body: "x", createdAt: "", url: "" }] } },
      { isResolved: true,  path: "b.ts", line: 2, diffSide: "RIGHT", comments: { nodes: [{ author: { login: "b" }, body: "y", createdAt: "", url: "" }] } },
    ]
    execSpy
      .mockResolvedValueOnce(prResponse)
      .mockResolvedValueOnce(remoteUrl)
      .mockResolvedValueOnce(makeGraphqlResponse(threads))

    const result = await fetchUnresolvedThreads()
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe("a.ts")
  })

  it("returns empty array when no PR exists", async () => {
    execSpy.mockRejectedValueOnce(new Error("no PR found"))
    expect(await fetchUnresolvedThreads()).toEqual([])
  })

  it("returns empty array when remote URL cannot be parsed", async () => {
    execSpy
      .mockResolvedValueOnce(prResponse)
      .mockResolvedValueOnce("not-a-git-url\n")
    expect(await fetchUnresolvedThreads()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// filterRunsByCommit
// ---------------------------------------------------------------------------

describe("filterRunsByCommit", () => {
  it("returns empty array for empty input", () => {
    expect(filterRunsByCommit([], "abc123")).toEqual([])
  })

  it("returns all runs when sha is empty", () => {
    const runs = [makeRun({ headSha: "abc123" }), makeRun({ headSha: "def456" })]
    expect(filterRunsByCommit(runs, "")).toHaveLength(2)
  })

  it("returns only runs matching the given SHA", () => {
    const match1 = makeRun({ databaseId: 1, headSha: "abc123" })
    const match2 = makeRun({ databaseId: 2, headSha: "abc123" })
    const other = makeRun({ databaseId: 3, headSha: "def456" })

    const result = filterRunsByCommit([match1, match2, other], "abc123")
    expect(result).toHaveLength(2)
    expect(result).not.toContain(other)
  })

  it("returns empty array when no runs match the SHA", () => {
    const runs = [makeRun({ headSha: "abc123" }), makeRun({ headSha: "abc123" })]
    expect(filterRunsByCommit(runs, "zzz999")).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// resolveThread
// ---------------------------------------------------------------------------

describe("resolveThread", () => {
  it("returns true when the mutation succeeds", async () => {
    execSpy.mockResolvedValueOnce(
      JSON.stringify({ data: { resolveReviewThread: { thread: { id: "T_abc", isResolved: true } } } }),
    )
    expect(await resolveThread("T_abc")).toBe(true)
    expect(execSpy).toHaveBeenCalledOnce()
    const callArgs = execSpy.mock.calls[0][0] as string[]
    expect(callArgs).toContain("graphql")
    expect(callArgs.join(" ")).toContain("T_abc")
  })

  it("returns an error string when the mutation throws", async () => {
    execSpy.mockRejectedValueOnce(new Error("Not authorized"))
    const result = await resolveThread("T_bad")
    expect(result).not.toBe(true)
    expect(result).toContain("Not authorized")
  })

  it("returns a generic error string for non-Error rejections", async () => {
    execSpy.mockRejectedValueOnce("oops")
    const result = await resolveThread("T_bad")
    expect(result).toBe("Unknown error resolving thread")
  })
})

// ---------------------------------------------------------------------------
// fetchUnresolvedThreadsWithIds
// ---------------------------------------------------------------------------

describe("fetchUnresolvedThreadsWithIds", () => {
  const prResponse = JSON.stringify({ number: 42 })
  const remoteUrl = "git@github.com:owner/repo.git\n"

  const makeGraphqlResponseWithIds = (
    threads: Array<{
      id: string
      isResolved: boolean
      path: string
      line: number | null
      diffSide: string
      comments: { nodes: Array<{ author: { login: string }; body: string; createdAt: string; url: string }> }
    }>,
  ) =>
    JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: threads } } } } })

  it("returns unresolved threads with their node IDs", async () => {
    const thread = {
      id: "PRRT_kwDOABC123",
      isResolved: false,
      path: "src/foo.ts",
      line: 10,
      diffSide: "RIGHT",
      comments: {
        nodes: [
          {
            author: { login: "alice" },
            body: "Please fix this",
            createdAt: "2024-01-01T00:00:00Z",
            url: "https://github.com/owner/repo/pull/42#discussion_r1",
          },
        ],
      },
    }
    execSpy
      .mockResolvedValueOnce(prResponse)
      .mockResolvedValueOnce(remoteUrl)
      .mockResolvedValueOnce(makeGraphqlResponseWithIds([thread]))

    const result = await fetchUnresolvedThreadsWithIds()
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("PRRT_kwDOABC123")
    expect(result[0].path).toBe("src/foo.ts")
    expect(result[0].line).toBe(10)
    expect(result[0].comments[0].author).toBe("alice")
  })

  it("filters out resolved threads", async () => {
    const threads = [
      {
        id: "T_1",
        isResolved: false,
        path: "a.ts",
        line: 1,
        diffSide: "RIGHT",
        comments: { nodes: [{ author: { login: "a" }, body: "x", createdAt: "", url: "" }] },
      },
      {
        id: "T_2",
        isResolved: true,
        path: "b.ts",
        line: 2,
        diffSide: "RIGHT",
        comments: { nodes: [{ author: { login: "b" }, body: "y", createdAt: "", url: "" }] },
      },
    ]
    execSpy
      .mockResolvedValueOnce(prResponse)
      .mockResolvedValueOnce(remoteUrl)
      .mockResolvedValueOnce(makeGraphqlResponseWithIds(threads))

    const result = await fetchUnresolvedThreadsWithIds()
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("T_1")
  })

  it("returns empty array when no PR exists", async () => {
    execSpy.mockRejectedValueOnce(new Error("no PR found"))
    expect(await fetchUnresolvedThreadsWithIds()).toEqual([])
  })

  it("returns empty array when remote URL cannot be parsed", async () => {
    execSpy
      .mockResolvedValueOnce(prResponse)
      .mockResolvedValueOnce("not-a-git-url\n")
    expect(await fetchUnresolvedThreadsWithIds()).toEqual([])
  })
})
