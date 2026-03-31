# opencode-gh-actions-status

An [OpenCode](https://opencode.ai) plugin that surfaces GitHub Actions workflow run statuses and unresolved PR review comments directly in your editor.

## Features

- **Instant push detection**: Shows a "Waiting for CI..." toast the moment you push to a branch — before GitHub has even queued the run
- **Live status updates**: Transitions through `Waiting for CI...` → `1 running` → `1 passing` (or `1 failing`) as the run progresses
- **Unresolved comment count**: Toast includes a count of unresolved PR review threads so you always know if there is feedback waiting
- **Sidebar panel**: Color-coded list of the latest workflow runs for your current branch
- **Agent tool**: The AI agent can call `gh_actions` to check CI status and read the full text of unresolved review comments, enabling it to proactively address reviewer feedback

## Requirements

- [GitHub CLI (`gh`)](https://cli.github.com/) installed and authenticated
- [Git](https://git-scm.com/) available in your PATH

## Installation

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-gh-actions-status"]
}
```

## Configuration

Pass options as a tuple:

```json
{
  "plugin": [
    ["opencode-gh-actions-status", {
      "branch": "main",
      "limit": 10,
      "workflows": ["ci.yml", "deploy.yml"],
      "pollInterval": 30000,
      "watchInterval": 5000
    }]
  ]
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `branch` | `string` | `"current"` | Branch to check. `"current"` uses the active git branch. |
| `limit` | `number` | `5` | Maximum number of workflow runs to display. |
| `workflows` | `string[]` | all | Filter to specific workflow files. |
| `pollInterval` | `number` | `30000` | Cache TTL in ms for `gh run list` results. |
| `watchInterval` | `number` | `5000` | How often (ms) the background watcher checks for new runs and push events. |

## How it works

The plugin runs a background watcher on `watchInterval` (default 5s) that:

1. Detects when `HEAD` changes (new push) and immediately shows a "Waiting for CI..." toast
2. Polls `gh run list` for runs matching the current HEAD commit SHA
3. Once a run appears, starts a fast 10s poll loop that updates the toast through each state transition
4. On completion, shows the final result with a 30-minute toast duration

The toast message format:

```
1 passing
2 unresolved     ← only shown when there are unresolved PR review threads
```

## Status indicators

| Status | Color |
|--------|-------|
| `success` | Green |
| `failure` / `timed_out` | Red |
| `cancelled` / `skipped` | Yellow |
| `in_progress` / `queued` / `pending` | Blue |

## Agent tool: `gh_actions`

When the AI agent calls `gh_actions`, it receives:

- All workflow runs for the current HEAD commit with status, conclusion, and URL
- Full text of all unresolved PR review threads (file path, line number, author, comment body, and URL)

This allows the agent to proactively check CI results and address code review feedback without you having to ask.

## Development

```bash
bun install
bun run build
bun run test
```

For local testing, reference the built plugin in your `opencode.json`:

```json
{
  "plugin": ["file:///path/to/opencode-gh-actions-status/dist/index.js"]
}
```
