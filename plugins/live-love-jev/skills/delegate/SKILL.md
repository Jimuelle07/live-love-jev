---
name: delegate
description: Run a well-defined coding task (implement, refactor, add tests, fix a known bug) on a cheap OpenCode Go model instead of writing the code in this session. Returns a short report with the files changed.
argument-hint: <task>
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.js delegate *)
---

Delegate this task to OpenCode: $ARGUMENTS

1. Write a self-contained task description. OpenCode can't see this conversation, so include the files, the expected behavior, and how to verify it (e.g. which tests to run).
2. Run it from the project root:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.js delegate --dir "${CLAUDE_PROJECT_DIR}" "<task description>"
   ```
   Add `--model opencode-go/<model>` to pick a model (`opencode models opencode-go` lists them), or `--session <id>` from a previous report to follow up in the same OpenCode session.
3. The command prints a report with the status, the files changed, and OpenCode's summary. Check the changed files before you rely on them. If the status is `maybe_incomplete` or `failed`, follow up with `--session` or do the work yourself.
