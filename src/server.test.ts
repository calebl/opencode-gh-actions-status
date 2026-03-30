import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { parseOptions } from "./server.js"
import { server } from "./server.js"
import type { WorkflowRun, ShellFn } from "./gh.js"

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
})

// ---------------------------------------------------------------------------
// server — toast behaviour via session.idle events
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

/** Build a PluginInput mock with a controllable shell and a spy on showToast. */
function makeInput(shellOutput: string | WorkflowRun[]) {
  const runsJson =
    typeof shellOutput === "string" ? shellOutput : JSON.stringify(shellOutput)

  const showToast = vi.fn().mockResolvedValue(undefined)

  // Shell returns branch on first call, runs on second call
  const $ = vi
    .fn()
    .mockReturnValueOnce({ quiet: () => ({ text: () => Promise.resolve("main\n") }) })
    .mockReturnValue({
      quiet: () => ({ text: () => Promise.resolve(runsJson) }),
    }) as unknown as ShellFn

  const input = {
    $,
    client: { tui: { showToast } },
    project: {},
    directory: "/tmp/repo",
    worktree: "/tmp/repo",
    serverUrl: "http://localhost:4242" as any,
  } as any // eslint-disable-line @typescript-eslint/no-explicit-any

  return { input, showToast, $ }
}

async function fireIdle(hooks: any) {
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
}

describe("server — toast on session.idle", () => {
  it("shows a success toast when all runs pass", async () => {
    const runs = [makeRun({ conclusion: "success" }), makeRun({ name: "Lint", conclusion: "success" })]
    const { input, showToast } = makeInput(runs)

    const hooks = await server(input)
    await fireIdle(hooks)

    expect(showToast).toHaveBeenCalledOnce()
    const body = showToast.mock.calls[0][0].body
    expect(body.variant).toBe("success")
    expect(body.message).toBe("2 passing")
    expect(body.title).toBe("GitHub Actions")
  })

  it("shows an error toast when a run is failing", async () => {
    const runs = [
      makeRun({ conclusion: "success" }),
      makeRun({ name: "Deploy", conclusion: "failure" }),
    ]
    const { input, showToast } = makeInput(runs)

    const hooks = await server(input)
    await fireIdle(hooks)

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

    const body = showToast.mock.calls[0][0].body
    expect(body.variant).toBe("warning")
    expect(body.message).toBe("1 cancelled")
  })

  it("shows an info toast when a run is in-progress", async () => {
    const runs = [makeRun({ status: "in_progress", conclusion: null })]
    const { input, showToast } = makeInput(runs)

    const hooks = await server(input)
    await fireIdle(hooks)

    const body = showToast.mock.calls[0][0].body
    expect(body.variant).toBe("info")
    expect(body.message).toBe("1 running")
  })

  it("does not show a toast when there are no runs", async () => {
    const { input, showToast } = makeInput([])

    const hooks = await server(input)
    await fireIdle(hooks)

    expect(showToast).not.toHaveBeenCalled()
  })

  it("does not repeat the same toast on consecutive idle events", async () => {
    const runs = [makeRun()]
    const { input, showToast, $ } = makeInput(runs)

    const hooks = await server(input)
    await fireIdle(hooks)

    // Reset the shell mock so the second idle re-uses cached runs
    // (cache is warm — no new shell call needed within pollInterval)
    await fireIdle(hooks)

    // Toast should only fire once since nothing changed
    expect(showToast).toHaveBeenCalledOnce()
  })

  it("shows a new toast when status changes between idle events", async () => {
    vi.useFakeTimers()
    const showToast = vi.fn().mockResolvedValue(undefined)

    // Shell call sequence: branch, passing runs, branch, failing runs
    const $ = vi
      .fn()
      .mockReturnValueOnce({ quiet: () => ({ text: () => Promise.resolve("main\n") }) })
      .mockReturnValueOnce({
        quiet: () => ({
          text: () => Promise.resolve(JSON.stringify([makeRun({ conclusion: "success" })])),
        }),
      })
      .mockReturnValueOnce({ quiet: () => ({ text: () => Promise.resolve("main\n") }) })
      .mockReturnValueOnce({
        quiet: () => ({
          text: () => Promise.resolve(JSON.stringify([makeRun({ conclusion: "failure" })])),
        }),
      }) as unknown as ShellFn

    const input = {
      $,
      client: { tui: { showToast } },
      project: {},
      directory: "/tmp/repo",
      worktree: "/tmp/repo",
      serverUrl: "http://localhost:4242" as any,
    } as any

    const hooks = await server(input, { pollInterval: 1000 })

    await fireIdle(hooks)
    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast.mock.calls[0][0].body.variant).toBe("success")

    // Advance past the poll interval so the cache expires
    vi.advanceTimersByTime(2000)

    await fireIdle(hooks)
    expect(showToast).toHaveBeenCalledTimes(2)
    expect(showToast.mock.calls[1][0].body.variant).toBe("error")

    vi.useRealTimers()
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
    const hooks = await server(input) as any

    const result = await hooks.tool.gh_actions.execute({})
    expect(result).toContain("✓ CI: success")
    expect(result).toContain("✗ Deploy: failure")
  })

  it("returns message when no runs found", async () => {
    const { input } = makeInput([])
    const hooks = await server(input) as any

    const result = await hooks.tool.gh_actions.execute({})
    expect(result).toMatch(/no workflow runs/i)
  })
})
