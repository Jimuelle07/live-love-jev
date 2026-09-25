---
name: handoff
description: Save the parts of this conversation still needed for the current task, so you can /clear instead of /compact.
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" handoff "${CLAUDE_SESSION_ID}" "${CLAUDE_PROJECT_DIR}"`

Relay the line above to the user in one sentence. Do nothing else — no tool calls, no summary.
