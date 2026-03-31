# GitHub Actions Status

Check GitHub Actions workflow run statuses and unresolved PR review comments for the current branch.

## When to use

- After pushing code or when asked about CI status
- When a toast notification indicates CI is running, passing, or failing
- When asked to fix CI failures or address review comments
- Before creating a pull request to verify all checks pass

## How to use

Call the `gh_actions` tool with no arguments to get the current status. It returns:

- Workflow runs with their status (running, queued, success, failure, cancelled) and URLs
- Full text of any unresolved PR review threads so you can read and address them

### Arguments

- `branch` (optional): Branch to check. Defaults to the current git branch.
- `limit` (optional): Maximum number of runs to return (default: 5).

## Interpreting results

- **running/queued**: CI is still in progress. Wait or check back later.
- **success**: All checks passed.
- **failure**: One or more checks failed. Read the run URL for logs, diagnose the issue, and fix it.
- **cancelled**: The run was cancelled, possibly due to a newer push superseding it.

When unresolved review comments are present, read each comment carefully and address the reviewer's feedback.
