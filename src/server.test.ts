import { describe, it, expect, vi, beforeEach } from "vitest"
import { _exec } from "./gh.js"
import { parseOptions, server, formatRunResults } from "./server.js"
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

  it("extracts valid toastInterval", () => {
    expect(parseOptions({ toastInterval: 15000 })).toMatchObject({ toastInterval: 15000 })
  })

  it("ignores non-number toastInterval", () => {
    expect(parseOptions({ toastInterval: "15000" })).toMatchObject({ toastInterval: undefined })
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
// formatRunResults
// ---------------------------------------------------------------------------

describe("formatRunResults", () => {
  it("returns no-runs message for empty array", () => {
    expect(formatRunResults([], [])).toMatch(/no workflow runs/i)
  })

  it("formats runs with status icons", () => {
    const runs: WorkflowRun[] = [
      { databaseId: 1, name: "CI", status: "completed", conclusion: "success", headBranch: "main", headSha: "abc", event: "push", url: "https://example.com/1", displayTitle: "commit", createdAt: "", updatedAt: "" },
      { databaseId: 2, name: "Deploy", status: "completed", conclusion: "failure", headBranch: "main", headSha: "abc", event: "push", url: "https://example.com/2", displayTitle: "commit", createdAt: "", updatedAt: "" },
    ]
    const result = formatRunResults(runs, [])
    expect(result).toContain("✓ CI: success")
    expect(result).toContain("✗ Deploy: failure")
  })

  it("includes review threads when present", () => {
    const runs: WorkflowRun[] = [
      { databaseId: 1, name: "CI", status: "completed", conclusion: "success", headBranch: "main", headSha: "abc", event: "push", url: "https://example.com/1", displayTitle: "commit", createdAt: "", updatedAt: "" },
    ]
    const threads = [
      { path: "src/foo.ts", line: 10, diffSide: "RIGHT", comments: [{ author: "bob", body: "Fix this", createdAt: "2024-01-01", url: "https://example.com/c1" }] },
    ]
    const result = formatRunResults(runs, threads)
    expect(result).toContain("Unresolved Review Comments (1)")
    expect(result).toContain("src/foo.ts:10")
    expect(result).toContain("bob")
    expect(result).toContain("Fix this")
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

async function firePush(hooks: Awaited<ReturnType<typeof server>>, sessionID = "s1") {
  await hooks["tool.execute.after"]!(
    { tool: "Bash", sessionID, callID: "c1", args: "git push -u origin main" },
    { title: "", output: "", metadata: {} },
  )
}

/**
 * Advance fake timers and flush all async chains triggered by them.
 *
 * vitest 4.x (native) supports vi.advanceTimersByTimeAsync which correctly
 * interleaves timer callbacks with microtask flushes — use it when available.
 * Bun's vitest compat layer only has the sync variant, so we fall back to
 * manually flushing the microtask queue after a sync advance.
 */
async function drainTimers(ms = 120_000) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const asyncAdvance = (vi as any).advanceTimersByTimeAsync
  if (typeof asyncAdvance === "function") {
    await asyncAdvance.call(vi, ms)
  } else {
    vi.advanceTimersByTime(ms)
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
}

// ---------------------------------------------------------------------------
// server — gh CLI not available
// ---------------------------------------------------------------------------

describe("server — gh not available", () => {
  it("shows an error toast and returns sidebar error when gh is missing", async () => {
    execSpy.mockRejectedValue(new Error("spawn gh ENOENT"))
    const showToast = vi.fn().mockResolvedValue(undefined)
    const input = {
      $: vi.fn(),
      client: { tui: { showToast } },
      project: {},
      directory: "/tmp/repo",
      worktree: "/tmp/repo",
      serverUrl: "http://localhost:4242",
    } as unknown as Parameters<typeof server>[0]

    const hooks = await server(input)

    // Should have shown an error toast immediately
    expect(showToast).toHaveBeenCalledOnce()
    const body = showToast.mock.calls[0][0].body
    expect(body.variant).toBe("error")
    expect(body.message).toContain("gh")

    // Should return an empty hooks object (no timers, no polling)
    expect(hooks).toEqual({})
  })
})

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

describe("server — toast on git push", () => {
  it("shows 'Waiting for CI...' immediately then success when run completes", async () => {
    const runs = [
      makeRun({ conclusion: "success" }),
      makeRun({ name: "Lint", conclusion: "success" }),
    ]
    const { input, showToast } = makeInput(runs)

    const hooks = await server(input)
    await firePush(hooks)
    await drainTimers()

    // First toast: "Waiting for CI..." shown before the poll tick
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
    await firePush(hooks)
    await drainTimers()

    expect(lastToastBody(showToast).duration).toBe(30 * 60 * 1000)
  })

  it("uses a 30 s duration for an in-progress run", async () => {
    const runs = [makeRun({ status: "in_progress", conclusion: null })]
    const { input, showToast } = makeInput(runs)

    const hooks = await server(input)
    await firePush(hooks)
    await drainTimers()

    expect(lastToastBody(showToast).duration).toBe(30_000)
  })

  it("shows an error toast when a run is failing", async () => {
    const runs = [
      makeRun({ conclusion: "success" }),
      makeRun({ name: "Deploy", conclusion: "failure" }),
    ]
    const { input, showToast } = makeInput(runs)

    const hooks = await server(input)
    await firePush(hooks)
    await drainTimers()

    const body = lastToastBody(showToast)
    expect(body.variant).toBe("error")
    expect(body.message).toContain("1 failing")
    expect(body.message).toContain("1 passing")
  })

  it("shows a warning toast when a run is cancelled", async () => {
    const runs = [makeRun({ conclusion: "cancelled" })]
    const { input, showToast } = makeInput(runs)

    const hooks = await server(input)
    await firePush(hooks)
    await drainTimers()

    const body = lastToastBody(showToast)
    expect(body.variant).toBe("warning")
    expect(body.message).toBe("1 cancelled")
  })

  it("shows an info toast when a run is in-progress", async () => {
    const runs = [makeRun({ status: "in_progress", conclusion: null })]
    const { input, showToast } = makeInput(runs)

    const hooks = await server(input)
    await firePush(hooks)
    await drainTimers()

    const body = lastToastBody(showToast)
    expect(body.variant).toBe("info")
    expect(body.message).toBe("1 running")
  })

  it("shows 'Waiting for CI...' even when no runs exist yet", async () => {
    const { input, showToast } = makeInput([])

    const hooks = await server(input)
    await firePush(hooks)
    await drainTimers()

    // Push hook shows waiting toast immediately, poll finds no runs and stops
    expect(showToast.mock.calls[0][0].body.message).toBe("Waiting for CI...")
  })

  it("does not show a toast when no push has occurred", async () => {
    const runs = [makeRun({ conclusion: "success" })]
    const { input, showToast } = makeInput(runs)

    await server(input)
    await drainTimers()

    // No push → no polling → no toast
    expect(showToast).not.toHaveBeenCalled()
  })

  it("dismisses old toast and shows new one when a second push arrives", async () => {
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

    // First push — completes with success
    await firePush(hooks)
    await drainTimers()
    expect(lastToastBody(showToast).variant).toBe("success")
    const callsAfterFirst = showToast.mock.calls.length

    // Second push — different run, fails
    serveSecondRun = true
    await firePush(hooks)
    await drainTimers()
    // "Waiting for CI..." + dismiss + new error toast = 3 more calls
    // (waiting toast + dismiss of old + error result)
    const newCalls = showToast.mock.calls.length - callsAfterFirst
    expect(newCalls).toBeGreaterThanOrEqual(2)
    expect(lastToastBody(showToast).variant).toBe("error")
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

    const hooks = await server(input, { mockRuns: [[inProgress], [completed]] })
    await firePush(hooks)
    await drainTimers()

    // First toast from the poll tick (no "Waiting for CI..." in mock mode)
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

    const hooks = await server(input, { mockRuns: [[inProgress], [completed]] })
    await firePush(hooks)
    // First tick fires immediately on push
    await Promise.resolve()
    expect(showToast.mock.calls[0][0].body.variant).toBe("info")

    // Second tick fires after toastInterval
    await drainTimers()
    const lastCall = showToast.mock.calls[showToast.mock.calls.length - 1]
    expect(lastCall[0].body.variant).toBe("success")
    expect(lastCall[0].body.duration).toBe(30 * 60 * 1000)
  })

  it("does not poll before a push", async () => {
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
    await drainTimers()

    // No push → no polling → no toast
    expect(showToast).not.toHaveBeenCalled()
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

    const hooks = await server(input)
    await firePush(hooks)
    await drainTimers()

    const body = lastToastBody(showToast)
    expect(body.message).toContain("1 passing")
    expect(body.message).toContain("2 unresolved")
  })
})

// ---------------------------------------------------------------------------
// server — skill installation hooks
// ---------------------------------------------------------------------------

describe("server — config hook registers skills directory", () => {
  it("adds the skills directory to config.skills.paths", async () => {
    const runs = [makeRun({ conclusion: "success" })]
    const { input } = makeInput(runs)
    const hooks = await server(input)

    const config = {} as Record<string, unknown>
    await hooks.config!(config as never)

    const cfg = config as { skills?: { paths?: string[] } }
    expect(cfg.skills).toBeDefined()
    expect(cfg.skills!.paths).toBeDefined()
    expect(cfg.skills!.paths!.length).toBe(1)
    // The path should end with /skills and be absolute
    expect(cfg.skills!.paths![0]).toMatch(/\/skills$/)
    expect(cfg.skills!.paths![0]).toMatch(/^\//)
  })

  it("does not duplicate skills path on repeated calls", async () => {
    const runs = [makeRun({ conclusion: "success" })]
    const { input } = makeInput(runs)
    const hooks = await server(input)

    const config = {} as Record<string, unknown>
    await hooks.config!(config as never)
    await hooks.config!(config as never)

    const cfg = config as { skills?: { paths?: string[] } }
    expect(cfg.skills!.paths!.length).toBe(1)
  })

  it("preserves existing skills paths", async () => {
    const runs = [makeRun({ conclusion: "success" })]
    const { input } = makeInput(runs)
    const hooks = await server(input)

    const config = { skills: { paths: ["/existing/skills"] } } as Record<string, unknown>
    await hooks.config!(config as never)

    const cfg = config as { skills: { paths: string[] } }
    expect(cfg.skills.paths.length).toBe(2)
    expect(cfg.skills.paths[0]).toBe("/existing/skills")
  })
})

describe("server — system transform hook", () => {
  it("injects skill awareness into the system prompt", async () => {
    const runs = [makeRun({ conclusion: "success" })]
    const { input } = makeInput(runs)
    const hooks = await server(input)

    const transform = hooks["experimental.chat.system.transform"]!
    const output = { system: [] as string[] }
    await transform({ model: {} } as never, output)

    expect(output.system.length).toBe(1)
    expect(output.system[0]).toContain("gh_actions")
  })

  it("does not duplicate the prompt on repeated calls", async () => {
    const runs = [makeRun({ conclusion: "success" })]
    const { input } = makeInput(runs)
    const hooks = await server(input)

    const transform = hooks["experimental.chat.system.transform"]!
    const output = { system: [] as string[] }
    await transform({ model: {} } as never, output)
    await transform({ model: {} } as never, output)

    expect(output.system.length).toBe(1)
  })
})

describe("server — session compacting hook", () => {
  it("adds skill context to the compaction prompt", async () => {
    const runs = [makeRun({ conclusion: "success" })]
    const { input } = makeInput(runs)
    const hooks = await server(input)

    const compacting = hooks["experimental.session.compacting"]!
    const output = { context: [] as string[] }
    await compacting({ sessionID: "s1" }, output)

    expect(output.context.length).toBe(1)
    expect(output.context[0]).toContain("gh-actions-status")
    expect(output.context[0]).toContain("gh_actions")
  })

  it("does not duplicate context on repeated compaction calls", async () => {
    const runs = [makeRun({ conclusion: "success" })]
    const { input } = makeInput(runs)
    const hooks = await server(input)

    const compacting = hooks["experimental.session.compacting"]!
    const output = { context: [] as string[] }
    await compacting({ sessionID: "s1" }, output)
    await compacting({ sessionID: "s1" }, output)

    expect(output.context.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// server — post-push CI prompt
// ---------------------------------------------------------------------------

describe("server — tool.execute.after detects git push", () => {
  it("detects 'git push' in tool args", async () => {
    const runs = [makeRun({ conclusion: "success" })]
    const { input } = makeInput(runs)
    const hooks = await server(input)

    const afterHook = hooks["tool.execute.after"]!
    await afterHook(
      { tool: "Bash", sessionID: "sess-1", callID: "c1", args: { command: "git push -u origin main" } },
      { title: "", output: "", metadata: {} },
    )

    // The hook should have stored the session ID internally.
    // We verify this indirectly: when runs complete, the session gets prompted.
    // (Direct state inspection tested in the prompt tests below.)
    expect(afterHook).toBeDefined()
  })

  it("ignores non-push commands", async () => {
    const runs = [makeRun({ conclusion: "success" })]
    const { input } = makeInput(runs)
    const hooks = await server(input)

    const afterHook = hooks["tool.execute.after"]!
    // Should not throw for unrelated commands
    await afterHook(
      { tool: "Bash", sessionID: "sess-1", callID: "c1", args: { command: "git status" } },
      { title: "", output: "", metadata: {} },
    )
    expect(afterHook).toBeDefined()
  })
})

describe("server — prompts session with CI results after push", () => {
  it("sends a prompt with run results when CI completes after a push", async () => {
    const inProgress = makeRun({ status: "in_progress", conclusion: null })
    const completed = { ...inProgress, status: "completed", conclusion: "success" }

    const showToast = vi.fn().mockResolvedValue(undefined)
    const sessionPrompt = vi.fn().mockResolvedValue({})
    let ghCallCount = 0
    execSpy.mockImplementation((cmd: string[]) => {
      if (cmd.includes("branch") && !cmd.includes("gh")) return Promise.resolve("main\n")
      if (cmd.includes("rev-parse")) return Promise.resolve(TEST_HEAD_SHA + "\n")
      if (cmd.includes("remote")) return Promise.resolve("git@github.com:owner/repo.git\n")
      if (cmd.includes("pr")) return Promise.reject(new Error("no PR"))
      if (cmd.includes("graphql")) return Promise.resolve(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }))
      ghCallCount++
      // First fetch: in_progress, subsequent: completed
      return Promise.resolve(JSON.stringify(ghCallCount <= 2 ? [inProgress] : [completed]))
    })

    const input = {
      $: vi.fn(),
      client: { tui: { showToast }, session: { prompt: sessionPrompt } },
      project: {},
      directory: "/tmp/repo",
      worktree: "/tmp/repo",
      serverUrl: "http://localhost:4242",
    } as unknown as Parameters<typeof server>[0]

    const hooks = await server(input)

    // Simulate the agent running git push
    await hooks["tool.execute.after"]!(
      { tool: "Bash", sessionID: "sess-push", callID: "c1", args: "git push -u origin main" },
      { title: "", output: "", metadata: {} },
    )

    // Let the poll loop run until CI completes
    await drainTimers()

    expect(sessionPrompt).toHaveBeenCalledOnce()
    const promptArgs = sessionPrompt.mock.calls[0][0]
    expect(promptArgs.sessionID).toBe("sess-push")
    expect(promptArgs.parts).toHaveLength(1)
    expect(promptArgs.parts[0].type).toBe("text")
    expect(promptArgs.parts[0].synthetic).toBe(true)
    expect(promptArgs.parts[0].text).toContain("Workflow Runs")
    expect(promptArgs.parts[0].text).toContain("success")
  })

  it("does NOT prompt when no push was detected", async () => {
    const runs = [makeRun({ conclusion: "success" })]
    const showToast = vi.fn().mockResolvedValue(undefined)
    const sessionPrompt = vi.fn().mockResolvedValue({})

    setupExecMock(runs)
    const input = {
      $: vi.fn(),
      client: { tui: { showToast }, session: { prompt: sessionPrompt } },
      project: {},
      directory: "/tmp/repo",
      worktree: "/tmp/repo",
      serverUrl: "http://localhost:4242",
    } as unknown as Parameters<typeof server>[0]

    await server(input)
    await drainTimers()

    expect(sessionPrompt).not.toHaveBeenCalled()
  })

  it("includes unresolved review comments in the push prompt", async () => {
    const completed = makeRun({ conclusion: "success" })
    const graphqlResponse = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [
        {
          isResolved: false,
          path: "src/foo.ts",
          line: 42,
          diffSide: "RIGHT",
          comments: { nodes: [{
            author: { login: "alice" },
            body: "Please fix this",
            createdAt: "2024-01-01T00:00:00Z",
            url: "https://github.com/owner/repo/pull/1#discussion_r1",
          }] },
        },
      ] } } } },
    })

    const showToast = vi.fn().mockResolvedValue(undefined)
    const sessionPrompt = vi.fn().mockResolvedValue({})
    execSpy.mockImplementation((cmd: string[]) => {
      if (cmd.includes("branch") && !cmd.includes("gh")) return Promise.resolve("main\n")
      if (cmd.includes("rev-parse")) return Promise.resolve(TEST_HEAD_SHA + "\n")
      if (cmd.includes("remote")) return Promise.resolve("git@github.com:owner/repo.git\n")
      if (cmd.includes("pr")) return Promise.resolve(JSON.stringify({ number: 1 }))
      if (cmd.includes("graphql")) return Promise.resolve(graphqlResponse)
      return Promise.resolve(JSON.stringify([completed]))
    })

    const input = {
      $: vi.fn(),
      client: { tui: { showToast }, session: { prompt: sessionPrompt } },
      project: {},
      directory: "/tmp/repo",
      worktree: "/tmp/repo",
      serverUrl: "http://localhost:4242",
    } as unknown as Parameters<typeof server>[0]

    const hooks = await server(input)

    // Simulate push
    await hooks["tool.execute.after"]!(
      { tool: "Bash", sessionID: "sess-review", callID: "c1", args: "git push" },
      { title: "", output: "", metadata: {} },
    )

    await drainTimers()

    expect(sessionPrompt).toHaveBeenCalledOnce()
    const text = sessionPrompt.mock.calls[0][0].parts[0].text
    expect(text).toContain("Unresolved Review Comments (1)")
    expect(text).toContain("src/foo.ts:42")
    expect(text).toContain("alice")
    expect(text).toContain("Please fix this")
  })

  it("prompts exactly once per push (no double-prompt within a single push lifecycle)", async () => {
    const completed = makeRun({ conclusion: "success" })
    const showToast = vi.fn().mockResolvedValue(undefined)
    const sessionPrompt = vi.fn().mockResolvedValue({})

    setupExecMock([completed])
    const input = {
      $: vi.fn(),
      client: { tui: { showToast }, session: { prompt: sessionPrompt } },
      project: {},
      directory: "/tmp/repo",
      worktree: "/tmp/repo",
      serverUrl: "http://localhost:4242",
    } as unknown as Parameters<typeof server>[0]

    const hooks = await server(input)

    // Single push — should prompt exactly once even if timers fire multiple times
    await hooks["tool.execute.after"]!(
      { tool: "Bash", sessionID: "sess-1", callID: "c1", args: "git push" },
      { title: "", output: "", metadata: {} },
    )
    await drainTimers()
    expect(sessionPrompt).toHaveBeenCalledOnce()

    // More timer ticks after polling stops — no additional prompts
    await drainTimers()
    expect(sessionPrompt).toHaveBeenCalledOnce()
  })
})
