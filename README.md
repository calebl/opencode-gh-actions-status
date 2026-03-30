# opencode-gh-actions-status

An [OpenCode](https://opencode.ai) plugin that surfaces GitHub Actions workflow run statuses in the sidebar and provides a `gh_actions` tool for the AI agent.

## Features

- **Sidebar panel**: Shows the latest workflow runs for your current branch with color-coded status indicators
- **Agent tool**: The AI agent can call `gh_actions` to check CI status programmatically

## Requirements

- [GitHub CLI (`gh`)](https://cli.github.com/) installed and authenticated

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
      "pollInterval": 15000
    }]
  ]
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `branch` | `string` | `"current"` | Branch to check. `"current"` uses the active git branch. |
| `limit` | `number` | `5` | Maximum number of workflow runs to display. |
| `workflows` | `string[]` | all | Filter to specific workflow files. |
| `pollInterval` | `number` | `30000` | Milliseconds between sidebar refreshes. |

## Status Indicators

| Status | Indicator |
|--------|-----------|
| `success` | Green (success) |
| `failure` / `timed_out` | Red (error) |
| `cancelled` / `skipped` | Yellow (warning) |
| `in_progress` / `queued` / `pending` | Blue (info) |

## Development

```bash
npm install
npm run build
```

For local testing, reference the built plugin in your `opencode.json`:

```json
{
  "plugin": ["file:///path/to/opencode-gh-actions-status/dist/index.js"]
}
```
