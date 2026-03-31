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
 * Configure execSpy to handle the three command types the plugin calls:
 *   git branch --show-current  → "main"
 *   git rev-parse HEAD          → TEST_HEAD_SHA
 *   gh run list …               → JSON of runs
 */
function setupExecMock(runs: WorkflowRun[]) {
  const runsJson = JSON.stringify(runs)
  execSpy.mockImplementation((cmd: string[]) => {
    if (cmd.includes("branch")) return Promise.resolve("main\n")
    if (cmd.includes("rev-parse")) return Promise.resolve(TEST_HEAD_SHA + "\n")
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

describe("server — toast on session.idle", () => {
  it("shows a success toast when all runs pass", async () => {
    const runs = [
      makeRun({ conclusion: "success" }),
      makeRun({ name: "Lint", conclusion: "success" }),
    ]
    const { input, showToast } = makeInput(runs)

    const hooks = await server(input)
    await fireIdle(hooks)
    await vi.runOnlyPendingTimersAsync()

    expect(showToast).toHaveBeenCalledOnce()
    const body = showToast.mock.calls[0][0].body
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

    const body = showToast.mock.calls[0][0].body
    expect(body.duration).toBe(30 * 60 * 1000)
  })

  it("uses a ~10 s duration for an in-progress run", async () => {
    const runs = [makeRun({ status: "in_progress", conclusion: null })]
    const { input, showToast } = makeInput(runs)

    const hooks = await server(input)
    await fireIdle(hooks)
    await vi.runOnlyPendingTimersAsync()

    const body = showToast.mock.calls[0][0].body
    expect(body.duration).toBe(10_500)
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

    const body = showToast.mock.calls[0][0].body
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

    const body = showToast.mock.calls[0][0].body
    expect(body.variant).toBe("warning")
    expect(body.message).toBe("1 cancelled")
  })

  it("shows an info toast when a run is in-progress", async () => {
    const runs = [makeRun({ status: "in_progress", conclusion: null })]
    const { input, showToast } = makeInput(runs)

    const hooks = await server(input)
    await fireIdle(hooks)
    await vi.runOnlyPendingTimersAsync()

    const body = showToast.mock.calls[0][0].body
    expect(body.variant).toBe("info")
    expect(body.message).toBe("1 running")
  })

  it("does not show a toast when there are no runs", async () => {
    const { input, showToast } = makeInput([])

    const hooks = await server(input)
    await fireIdle(hooks)
    await vi.runOnlyPendingTimersAsync()

    expect(showToast).not.toHaveBeenCalled()
  })

  it("does not repeat the same toast on consecutive idle events", async () => {
    const runs = [makeRun()]
    const { input, showToast } = makeInput(runs)

    const hooks = await server(input)
    await fireIdle(hooks)
    await vi.runOnlyPendingTimersAsync()

    await fireIdle(hooks)
    await vi.runOnlyPendingTimersAsync()

    expect(showToast).toHaveBeenCalledOnce()
  })

  it("refreshes the toast every 10 s while a run is active", async () => {
    const activeRun = makeRun({ status: "in_progress", conclusion: null })
    const updatedRun = { ...activeRun, updatedAt: "2024-01-01T00:02:00Z" }

    const showToast = vi.fn().mockResolvedValue(undefined)
    let ghCallCount = 0
    execSpy.mockImplementation((cmd: string[]) => {
      if (cmd.includes("branch")) return Promise.resolve("main\n")
      if (cmd.includes("rev-parse")) return Promise.resolve(TEST_HEAD_SHA + "\n")
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
    expect(showToast).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(showToast).toHaveBeenCalledTimes(1)
  })

  it("dismisses old toast and shows new one when a new run starts", async () => {
    const firstRun = makeRun({ databaseId: 100, conclusion: "success" })
    const secondRun = makeRun({ databaseId: 200, conclusion: "failure" })

    const showToast = vi.fn().mockResolvedValue(undefined)
    let serveSecondRun = false
    execSpy.mockImplementation((cmd: string[]) => {
      if (cmd.includes("branch")) return Promise.resolve("main\n")
      if (cmd.includes("rev-parse")) return Promise.resolve(TEST_HEAD_SHA + "\n")
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
    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast.mock.calls[0][0].body.variant).toBe("success")

    // Switch to secondRun before the next idle triggers a fresh fetch
    serveSecondRun = true
    await fireIdle(hooks)
    await vi.runOnlyPendingTimersAsync()
    expect(showToast).toHaveBeenCalledTimes(3)
    expect(showToast.mock.calls[1][0].body.duration).toBe(1)
    expect(showToast.mock.calls[2][0].body.variant).toBe("error")
  })
})

// ---------------------------------------------------------------------------
// server — background watcher (external push detection)
// ---------------------------------------------------------------------------

describe("server — background watcher", () => {
  it("shows a toast for a run detected without session.idle", async () => {
    const runs = [makeRun({ conclusion: "success" })]
    const { input, showToast } = makeInput(runs)

    await server(input)
    await vi.runOnlyPendingTimersAsync()

    expect(showToast).toHaveBeenCalledOnce()
    expect(showToast.mock.calls[0][0].body.variant).toBe("success")
  })

  it("does not show a toast when no runs exist for HEAD", async () => {
    const runs = [makeRun({ headSha: "other-sha" })]
    const { input, showToast } = makeInput(runs)

    await server(input)
    await vi.runOnlyPendingTimersAsync()

    expect(showToast).not.toHaveBeenCalled()
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
    expect(showToast.mock.calls[0][0].body.duration).toBe(10_500)
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
})
