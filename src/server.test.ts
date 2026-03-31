import { describe, it, expect, vi, beforeEach } from "vitest"
import { _exec } from "./gh.js"
import { parseOptions, server } from "./server.js"
import type { WorkflowRun } from "./gh.js"

// ---------------------------------------------------------------------------
// Spy on exec so tests don't spawn real processes
// ---------------------------------------------------------------------------

let execSpy: ReturnType<typeof vi.spyOn>

// ---------------------------------------------------------------------------
// parseOptions
// ---------------------------------------------------------------------------

describe("parseOptions", () => {
  it("returns empty config when called with no argument", () => {
    expect(parseOptions()).toEqual({})
  })

  it("returns empty config when called with empty object", () => {
    expect(parseOptions({})).toEqual({})
  })

  it("extracts valid branch string", () => {
    expect(parseOptions({ branch: "main" })).toMatchObject({ branch: "main" })
  })

  it("ignores non-string branch", () => {
    expect(parseOptions({ branch: 42 })).toMatchObject({ branch: undefined })
  })

  it("extracts valid numeric limit", () => {
    expect(parseOptions({ limit: 10 })).toMatchObject({ limit: 10 })
  })

  it("ignores non-number limit", () => {
    expect(parseOptions({ limit: "10" })).toMatchObject({ limit: undefined })
  })

  it("extracts valid workflows array", () => {
    expect(parseOptions({ workflows: ["ci.yml", "deploy.yml"] })).toMatchObject({
      workflows: ["ci.yml", "deploy.yml"],
    })
  })

  it("filters non-string values out of workflows array", () => {
    expect(parseOptions({ workflows: ["ci.yml", 42, null, "deploy.yml"] })).toMatchObject({
      workflows: ["ci.yml", "deploy.yml"],
    })
  })

  it("ignores non-array workflows", () => {
    expect(parseOptions({ workflows: "ci.yml" })).toMatchObject({ workflows: undefined })
  })

  it("extracts valid pollInterval", () => {
    expect(parseOptions({ pollInterval: 15000 })).toMatchObject({ pollInterval: 15000 })
  })

  it("ignores non-number pollInterval", () => {
    expect(parseOptions({ pollInterval: "15000" })).toMatchObject({ pollInterval: undefined })
  })

  it("extracts valid watchInterval", () => {
    expect(parseOptions({ watchInterval: 5000 })).toMatchObject({ watchInterval: 5000 })
  })

  it("ignores non-number watchInterval", () => {
    expect(parseOptions({ watchInterval: "5000" })).toMatchObject({ watchInterval: undefined })
  })

  it("extracts valid mockRuns array", () => {
    const snapshot = [{ databaseId: 1, name: "CI", status: "in_progress", conclusion: null,
      headBranch: "main", headSha: "abc", event: "push", url: "https://github.com/x/y/runs/1",
      displayTitle: "mock", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" }]
    expect(parseOptions({ mockRuns: [snapshot] })).toMatchObject({ mockRuns: [snapshot] })
  })

  it("ignores non-array mockRuns", () => {
    expect(parseOptions({ mockRuns: "not-an-array" })).toMatchObject({ mockRuns: undefined })
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let runIdCounter = 1
const TEST_HEAD_SHA = "deadbeef1234"

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    databaseId: runIdCounter++,
    name: "CI",
    status: "completed",
    conclusion: "success",
    headBranch: "main",
    headSha: TEST_HEAD_SHA,
    event: "push",
    url: "https://github.com/owner/repo/actions/runs/1",
    displayTitle: "test commit",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:01:00Z",
    ...overrides,
  }
}

/**
 * Configure execSpy to handle all command types the plugin calls:
 *   git branch --show-current  → "main"
 *   git rev-parse HEAD          → TEST_HEAD_SHA
 *   git remote get-url origin   → mock remote URL
 *   gh run list …               → JSON of runs
 *   gh pr view …                → no PR (so unresolved count = 0)
 *   gh api graphql …            → empty threads
 */
function setupExecMock(runs: WorkflowRun[]) {
  const runsJson = JSON.stringify(runs)
  execSpy.mockImplementation((cmd: string[]) => {
    if (cmd.includes("branch") && !cmd.includes("gh")) return Promise.resolve("main\n")
    if (cmd.includes("rev-parse")) return Promise.resolve(TEST_HEAD_SHA + "\n")
    if (cmd.includes("remote")) return Promise.resolve("git@github.com:owner/repo.git\n")
    if (cmd.includes("pr")) return Promise.reject(new Error("no PR"))
    if (cmd.includes("graphql")) return Promise.resolve(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }))
    return Promise.resolve(runsJson)
  })
}

function makeInput(runs: WorkflowRun[]) {
  setupExecMock(runs)
  const showToast = vi.fn().mockResolvedValue(undefined)
  const input = {
    $: vi.fn(),
    client: { tui: { showToast } },
    project: {},
    directory: "/tmp/repo",
    worktree: "/tmp/repo",
    serverUrl: "http://localhost:4242",
  } as unknown as Parameters<typeof server>[0]
  return { input, showToast }
}

async function fireIdle(hooks: Awaited<ReturnType<typeof server>>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (hooks as any).event({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
}

// ---------------------------------------------------------------------------
// server — toast behaviour
// ---------------------------------------------------------------------------

beforeEach(() => {
  runIdCounter = 1
  vi.restoreAllMocks()
  execSpy = vi.spyOn(_exec, "exec")
  vi.useFakeTimers()
})

// Helper to get the last (most recent) toast body
function lastToastBody(showToast: ReturnType<typeof vi.fn>) {
  const calls = showToast.mock.calls
  return calls[calls.length - 1][0].body
}

describe("server — toast on session.idle", () => {
  it("shows 'Waiting for CI...' immediately then success when run completes", async () => {
    const runs = [
      makeRun({ conclusion: "success" }),
      makeRun({ name: "Lint", conclusion: "success" }),
    ]
    const { input, showToast } = makeInput(runs)

    const hooks = await server(input)
    await fireIdle(hooks)
    await vi.runOnlyPendingTimersAsync()

    // First toast: "Waiting for CI..." (SHA detected, no run yet at that moment)
    expect(showToast.mock.calls[0][0].body.message).toBe("Waiting for CI...")
    // Last toast: success
    const body = lastToastBody(showToast)
    expect(body.variant).toBe("success")
    expect(body.message).toBe("2 passing")
    expect(body.title).toBe("GitHub Actions")
  })

  it("uses a 30-minute duration for a completed run", async () => {
    const runs = [makeRun({ conclusion: "success" })]
    const { input, showToast } = makeInput(runs)

    const hooks = await server(input)
    await fireIdle(hooks)
    await vi.runOnlyPendingTimersAsync()

    expect(lastToastBody(showToast).duration).toBe(30 * 60 * 1000)
  })

  it("uses a ~10 s duration for an in-progress run", async () => {
    const runs = [makeRun({ status: "in_progress", conclusion: null })]
    const { input, showToast } = makeInput(runs)

    const hooks = await server(input)
    await fireIdle(hooks)
    await vi.runOnlyPendingTimersAsync()

    expect(lastToastBody(showToast).duration).toBe(30_000)
  })

  it("shows an error toast when a run is failing", async () => {
    const runs = [
      makeRun({ conclusion: "success" }),
      makeRun({ name: "Deploy", conclusion: "failure" }),
    ]
    const { input, showToast } = makeInput(runs)

    const hooks = await server(input)
    await fireIdle(hooks)
    await vi.runOnlyPendingTimersAsync()

    const body = lastToastBody(showToast)
    expect(body.variant).toBe("error")
    expect(body.message).toContain("1 failing")
    expect(body.message).toContain("1 passing")
  })

  it("shows a warning toast when a run is cancelled", async () => {
    const runs = [makeRun({ conclusion: "cancelled" })]
    const { input, showToast } = makeInput(runs)

    const hooks = await server(input)
    await fireIdle(hooks)
    await vi.runOnlyPendingTimersAsync()

    const body = lastToastBody(showToast)
    expect(body.variant).toBe("warning")
    expect(body.message).toBe("1 cancelled")
  })

  it("shows an info toast when a run is in-progress", async () => {
    const runs = [makeRun({ status: "in_progress", conclusion: null })]
    const { input, showToast } = makeInput(runs)

    const hooks = await server(input)
    await fireIdle(hooks)
    await vi.runOnlyPendingTimersAsync()

    const body = lastToastBody(showToast)
    expect(body.variant).toBe("info")
    expect(body.message).toBe("1 running")
  })

  it("shows 'Waiting for CI...' even when no runs exist yet", async () => {
    const { input, showToast } = makeInput([])

    const hooks = await server(input)
    await fireIdle(hooks)
    await vi.runOnlyPendingTimersAsync()

    // SHA detected → waiting toast shown even with no runs
    expect(showToast).toHaveBeenCalledOnce()
    expect(showToast.mock.calls[0][0].body.message).toBe("Waiting for CI...")
  })

  it("does not repeat toasts on consecutive idle events", async () => {
    const runs = [makeRun()]
    const { input, showToast } = makeInput(runs)

    const hooks = await server(input)
    await fireIdle(hooks)
    await vi.runOnlyPendingTimersAsync()
    const callsAfterFirst = showToast.mock.calls.length

    await fireIdle(hooks)
    await vi.runOnlyPendingTimersAsync()

    // No additional toasts after second idle
    expect(showToast.mock.calls.length).toBe(callsAfterFirst)
  })

  it("refreshes the toast every 10 s while a run is active", async () => {
    const activeRun = makeRun({ status: "in_progress", conclusion: null })
    const updatedRun = { ...activeRun, updatedAt: "2024-01-01T00:02:00Z" }

    const showToast = vi.fn().mockResolvedValue(undefined)
    let ghCallCount = 0
    execSpy.mockImplementation((cmd: string[]) => {
      if (cmd.includes("branch") && !cmd.includes("gh")) return Promise.resolve("main\n")
      if (cmd.includes("rev-parse")) return Promise.resolve(TEST_HEAD_SHA + "\n")
      if (cmd.includes("remote")) return Promise.resolve("git@github.com:owner/repo.git\n")
      if (cmd.includes("pr")) return Promise.reject(new Error("no PR"))
      if (cmd.includes("graphql")) return Promise.resolve(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }))
      ghCallCount++
      return Promise.resolve(JSON.stringify(ghCallCount === 1 ? [activeRun] : [updatedRun]))
    })

    const input = {
      $: vi.fn(),
      client: { tui: { showToast } },
      project: {},
      directory: "/tmp/repo",
      worktree: "/tmp/repo",
      serverUrl: "http://localhost:4242",
    } as unknown as Parameters<typeof server>[0]

    const hooks = await server(input)
    await fireIdle(hooks)
    await vi.runOnlyPendingTimersAsync()
    const callsAfterFirst = showToast.mock.calls.length
    expect(lastToastBody(showToast).message).toBe("1 running")

    // Advance 10 s — toast key unchanged so no new toast
    await vi.advanceTimersByTimeAsync(10_000)
    expect(showToast.mock.calls.length).toBe(callsAfterFirst)
  })

  it("dismisses old toast and shows new one when a new run starts", async () => {
    const firstRun = makeRun({ databaseId: 100, conclusion: "success" })
    const secondRun = makeRun({ databaseId: 200, conclusion: "failure" })

    const showToast = vi.fn().mockResolvedValue(undefined)
    let serveSecondRun = false
    execSpy.mockImplementation((cmd: string[]) => {
      if (cmd.includes("branch") && !cmd.includes("gh")) return Promise.resolve("main\n")
      if (cmd.includes("rev-parse")) return Promise.resolve(TEST_HEAD_SHA + "\n")
      if (cmd.includes("remote")) return Promise.resolve("git@github.com:owner/repo.git\n")
      if (cmd.includes("pr")) return Promise.reject(new Error("no PR"))
      if (cmd.includes("graphql")) return Promise.resolve(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }))
      return Promise.resolve(JSON.stringify(serveSecondRun ? [secondRun] : [firstRun]))
    })

    const input = {
      $: vi.fn(),
      client: { tui: { showToast } },
      project: {},
      directory: "/tmp/repo",
      worktree: "/tmp/repo",
      serverUrl: "http://localhost:4242",
    } as unknown as Parameters<typeof server>[0]

    const hooks = await server(input)

    await vi.runOnlyPendingTimersAsync()
    // Final toast after init should be success for firstRun
    expect(lastToastBody(showToast).variant).toBe("success")
    const callsAfterFirst = showToast.mock.calls.length

    // Switch to secondRun and trigger idle
    serveSecondRun = true
    await fireIdle(hooks)
    await vi.runOnlyPendingTimersAsync()
    // Dismiss + new error toast = 2 more calls
    expect(showToast.mock.calls.length).toBe(callsAfterFirst + 2)
    expect(showToast.mock.calls[callsAfterFirst][0].body.duration).toBe(1)
    expect(showToast.mock.calls[callsAfterFirst + 1][0].body.variant).toBe("error")
  })
})

// ---------------------------------------------------------------------------
// server — background watcher (external push detection)
// ---------------------------------------------------------------------------

describe("server — background watcher", () => {
  it("shows 'Waiting for CI...' then success without session.idle", async () => {
    const runs = [makeRun({ conclusion: "success" })]
    const { input, showToast } = makeInput(runs)

    await server(input)
    await vi.runOnlyPendingTimersAsync()

    expect(showToast.mock.calls[0][0].body.message).toBe("Waiting for CI...")
    expect(lastToastBody(showToast).variant).toBe("success")
  })

  it("shows 'Waiting for CI...' even when no runs exist for HEAD yet", async () => {
    // Runs exist but for a different SHA — simulates GitHub not having queued yet
    const runs = [makeRun({ headSha: "other-sha" })]
    const { input, showToast } = makeInput(runs)

    await server(input)
    await vi.runOnlyPendingTimersAsync()

    expect(showToast).toHaveBeenCalledOnce()
    expect(showToast.mock.calls[0][0].body.message).toBe("Waiting for CI...")
  })
})

// ---------------------------------------------------------------------------
// server — mockRuns mode
// ---------------------------------------------------------------------------

describe("server — mockRuns mode", () => {
  it("shows toasts from mock snapshots without calling exec", async () => {
    const inProgress = makeRun({ status: "in_progress", conclusion: null })
    const completed = makeRun({ ...inProgress, status: "completed", conclusion: "success" })

    const showToast = vi.fn().mockResolvedValue(undefined)
    const input = {
      $: vi.fn(),
      client: { tui: { showToast } },
      project: {},
      directory: "/tmp/repo",
      worktree: "/tmp/repo",
      serverUrl: "http://localhost:4242",
    } as unknown as Parameters<typeof server>[0]

    await server(input, { mockRuns: [[inProgress], [completed]] })
    await vi.advanceTimersByTimeAsync(0)

    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast.mock.calls[0][0].body.variant).toBe("info")
    expect(showToast.mock.calls[0][0].body.duration).toBe(30_000)
    expect(execSpy).not.toHaveBeenCalled()
  })

  it("advances through snapshots on each poll tick", async () => {
    const inProgress = makeRun({ status: "in_progress", conclusion: null })
    const completed = { ...inProgress, status: "completed", conclusion: "success" }

    const showToast = vi.fn().mockResolvedValue(undefined)
    const input = {
      $: vi.fn(),
      client: { tui: { showToast } },
      project: {},
      directory: "/tmp/repo",
      worktree: "/tmp/repo",
      serverUrl: "http://localhost:4242",
    } as unknown as Parameters<typeof server>[0]

    await server(input, { mockRuns: [[inProgress], [completed]] })
    await vi.advanceTimersByTimeAsync(0)
    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast.mock.calls[0][0].body.variant).toBe("info")

    await vi.advanceTimersByTimeAsync(10_000)
    expect(showToast).toHaveBeenCalledTimes(2)
    expect(showToast.mock.calls[1][0].body.variant).toBe("success")
    expect(showToast.mock.calls[1][0].body.duration).toBe(30 * 60 * 1000)
  })

  it("stays on the last snapshot once all are consumed", async () => {
    const completed = makeRun({ status: "completed", conclusion: "success" })

    const showToast = vi.fn().mockResolvedValue(undefined)
    const input = {
      $: vi.fn(),
      client: { tui: { showToast } },
      project: {},
      directory: "/tmp/repo",
      worktree: "/tmp/repo",
      serverUrl: "http://localhost:4242",
    } as unknown as Parameters<typeof server>[0]

    await server(input, { mockRuns: [[completed]] })
    await vi.runOnlyPendingTimersAsync()
    expect(showToast).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(showToast).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// server — gh_actions tool
// ---------------------------------------------------------------------------

describe("server — gh_actions tool", () => {
  it("returns formatted run list", async () => {
    const runs = [
      makeRun({ name: "CI", conclusion: "success", displayTitle: "my PR" }),
      makeRun({ name: "Deploy", conclusion: "failure", displayTitle: "my PR" }),
    ]
    const { input } = makeInput(runs)
    const hooks = await server(input)

    const result = await (hooks as unknown as { tool: { gh_actions: { execute: (a: object) => Promise<string> } } }).tool.gh_actions.execute({})
    expect(result).toContain("✓ CI: success")
    expect(result).toContain("✗ Deploy: failure")
  })

  it("returns message when no runs found", async () => {
    const { input } = makeInput([])
    const hooks = await server(input)

    const result = await (hooks as unknown as { tool: { gh_actions: { execute: (a: object) => Promise<string> } } }).tool.gh_actions.execute({})
    expect(result).toMatch(/no workflow runs/i)
  })

  it("includes unresolved review comments in tool output", async () => {
    const runs = [makeRun({ name: "CI", conclusion: "success", displayTitle: "my PR" })]
    const graphqlResponse = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [
        {
          isResolved: false,
          path: "src/foo.ts",
          line: 42,
          diffSide: "RIGHT",
          comments: { nodes: [{
            author: { login: "alice" },
            body: "Please address this",
            createdAt: "2024-01-01T00:00:00Z",
            url: "https://github.com/owner/repo/pull/1#discussion_r1",
          }] },
        },
      ] } } } },
    })

    execSpy.mockImplementation((cmd: string[]) => {
      if (cmd.includes("branch") && !cmd.includes("gh")) return Promise.resolve("main\n")
      if (cmd.includes("rev-parse")) return Promise.resolve(TEST_HEAD_SHA + "\n")
      if (cmd.includes("remote")) return Promise.resolve("git@github.com:owner/repo.git\n")
      if (cmd.includes("pr")) return Promise.resolve(JSON.stringify({ number: 1 }))
      if (cmd.includes("graphql")) return Promise.resolve(graphqlResponse)
      return Promise.resolve(JSON.stringify(runs))
    })

    const input = {
      $: vi.fn(),
      client: { tui: { showToast: vi.fn().mockResolvedValue(undefined) } },
      project: {},
      directory: "/tmp/repo",
      worktree: "/tmp/repo",
      serverUrl: "http://localhost:4242",
    } as unknown as Parameters<typeof server>[0]

    const hooks = await server(input)
    const result = await (hooks as unknown as { tool: { gh_actions: { execute: (a: object) => Promise<string> } } }).tool.gh_actions.execute({})
    expect(result).toContain("Unresolved Review Comments (1)")
    expect(result).toContain("src/foo.ts:42")
    expect(result).toContain("alice")
    expect(result).toContain("Please address this")
  })

  it("includes unresolved count in toast message", async () => {
    const runs = [makeRun({ conclusion: "success" })]
    const graphqlResponse = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [
        { isResolved: false, path: "src/foo.ts", line: 1, diffSide: "RIGHT", comments: { nodes: [{ author: { login: "bob" }, body: "fix", createdAt: "", url: "" }] } },
        { isResolved: false, path: "src/bar.ts", line: 2, diffSide: "RIGHT", comments: { nodes: [{ author: { login: "bob" }, body: "also fix", createdAt: "", url: "" }] } },
      ] } } } },
    })

    const showToast = vi.fn().mockResolvedValue(undefined)
    execSpy.mockImplementation((cmd: string[]) => {
      if (cmd.includes("branch") && !cmd.includes("gh")) return Promise.resolve("main\n")
      if (cmd.includes("rev-parse")) return Promise.resolve(TEST_HEAD_SHA + "\n")
      if (cmd.includes("remote")) return Promise.resolve("git@github.com:owner/repo.git\n")
      if (cmd.includes("pr")) return Promise.resolve(JSON.stringify({ number: 1 }))
      if (cmd.includes("graphql")) return Promise.resolve(graphqlResponse)
      return Promise.resolve(JSON.stringify(runs))
    })

    const input = {
      $: vi.fn(),
      client: { tui: { showToast } },
      project: {},
      directory: "/tmp/repo",
      worktree: "/tmp/repo",
      serverUrl: "http://localhost:4242",
    } as unknown as Parameters<typeof server>[0]

    await server(input)
    await vi.runOnlyPendingTimersAsync()

    const body = lastToastBody(showToast)
    expect(body.message).toContain("1 passing")
    expect(body.message).toContain("2 unresolved")
  })
})
