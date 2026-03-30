import { describe, it, expect, vi } from "vitest"
import {
  mapStatus,
  formatStatus,
  getCurrentBranch,
  fetchWorkflowRuns,
  type WorkflowRun,
  type ShellFn,
} from "./gh.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    name: "CI",
    status: "completed",
    conclusion: "success",
    headBranch: "main",
    event: "push",
    url: "https://github.com/owner/repo/actions/runs/1",
    displayTitle: "test commit",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:01:00Z",
    ...overrides,
  }
}

/** Build a minimal ShellFn mock that returns the given stdout string. */
function makeShell(stdout: string): ShellFn {
  return vi.fn().mockReturnValue({
    quiet: () => ({ text: () => Promise.resolve(stdout) }),
  })
}

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
// getCurrentBranch
// ---------------------------------------------------------------------------

describe("getCurrentBranch", () => {
  it("returns trimmed branch name", async () => {
    const $ = makeShell("  feature/my-branch\n")
    expect(await getCurrentBranch($)).toBe("feature/my-branch")
  })

  it("returns empty string when shell throws", async () => {
    const $ = vi.fn().mockReturnValue({
      quiet: () => ({ text: () => Promise.reject(new Error("not a git repo")) }),
    }) as unknown as ShellFn
    expect(await getCurrentBranch($)).toBe("")
  })
})

// ---------------------------------------------------------------------------
// fetchWorkflowRuns
// ---------------------------------------------------------------------------

describe("fetchWorkflowRuns", () => {
  it("returns parsed runs for the current branch", async () => {
    const runs: WorkflowRun[] = [makeRun({ name: "CI" }), makeRun({ name: "Deploy" })]
    // First call: git branch, second call: gh run list
    const $ = vi
      .fn()
      .mockReturnValueOnce({ quiet: () => ({ text: () => Promise.resolve("main\n") }) })
      .mockReturnValueOnce({
        quiet: () => ({ text: () => Promise.resolve(JSON.stringify(runs)) }),
      }) as unknown as ShellFn

    const result = await fetchWorkflowRuns($, {})
    expect(result).toHaveLength(2)
    expect(result[0].name).toBe("CI")
    expect(result[1].name).toBe("Deploy")
  })

  it("uses the provided branch instead of current branch", async () => {
    const runs: WorkflowRun[] = [makeRun()]
    const $ = vi.fn().mockReturnValue({
      quiet: () => ({ text: () => Promise.resolve(JSON.stringify(runs)) }),
    }) as unknown as ShellFn

    const result = await fetchWorkflowRuns($, { branch: "release/1.0" })
    // getCurrentBranch should NOT be called — only the gh run list call
    expect($).toHaveBeenCalledTimes(1)
    expect(result).toHaveLength(1)
  })

  it("returns empty array when current branch cannot be determined", async () => {
    const $ = vi.fn().mockReturnValue({
      quiet: () => ({ text: () => Promise.resolve("") }),
    }) as unknown as ShellFn

    const result = await fetchWorkflowRuns($, {})
    expect(result).toEqual([])
  })

  it("returns empty array when gh returns non-array JSON", async () => {
    const $ = vi
      .fn()
      .mockReturnValueOnce({ quiet: () => ({ text: () => Promise.resolve("main\n") }) })
      .mockReturnValueOnce({
        quiet: () => ({ text: () => Promise.resolve(JSON.stringify({ error: "oops" })) }),
      }) as unknown as ShellFn

    const result = await fetchWorkflowRuns($, {})
    expect(result).toEqual([])
  })

  it("respects the limit option", async () => {
    const runs = Array.from({ length: 3 }, (_, i) => makeRun({ name: `Run ${i}` }))
    const $ = vi
      .fn()
      .mockReturnValueOnce({ quiet: () => ({ text: () => Promise.resolve("main\n") }) })
      .mockReturnValueOnce({
        quiet: () => ({ text: () => Promise.resolve(JSON.stringify(runs)) }),
      }) as unknown as ShellFn

    const result = await fetchWorkflowRuns($, { limit: 3 })
    expect(result).toHaveLength(3)
  })
})
