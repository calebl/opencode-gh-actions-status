# GitHub Actions Status

Check GitHub Actions workflow run statuses and unresolved PR review comments for the current branch.

## When to use

- After pushing code or when asked about CI status
- When prompted by the plugin with CI results after a push
- When asked to fix CI failures or address review comments
- Before creating a pull request to verify all checks pass

## Tools

### `gh_actions`

Call with no arguments to get the current status. It returns:

- Workflow runs with their status (running, queued, success, failure, cancelled) and URLs
- Full text of any unresolved PR review threads, each with a thread ID for resolving

#### Arguments

- `branch` (optional): Branch to check. Defaults to the current git branch.
- `limit` (optional): Maximum number of runs to return (default: 5).

### `resolve_comment`

Marks one or more PR review threads as resolved on GitHub. Call `gh_actions` first to obtain thread IDs, then pass them to this tool.

#### Arguments

- `threadIds` (required): Array of GraphQL review thread node IDs to resolve (e.g. `["PRRT_kwDOABC123"]`).

#### Example workflow

1. Call `gh_actions` — note the thread ID shown next to each unresolved comment.
2. Address the reviewer's feedback in code.
3. Call `resolve_comment` with the thread ID(s) to mark them resolved.

## Interpreting results

- **running/queued**: CI is still in progress. Wait or check back later.
- **success**: All checks passed.
- **failure**: One or more checks failed. Read the run URL for logs, diagnose the issue, and fix it.
- **cancelled**: The run was cancelled, possibly due to a newer push superseding it.

When unresolved review comments are present, read each comment carefully and address the reviewer's feedback before resolving the thread.
