---
name: check
description: Check whether another model's or a background agent's output finished its task, without reading the whole output into context. Use when a result is saved to a file (background subagent output, Codex/Gemini run, long report).
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.js check *)
---

Judge a result against only its task, using Jev:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/cli.js check --task "<the task you gave>" --result @<path/to/output-file>
```

`--task` and `--result` each take text or `@file`. It prints one line:
`{"verdict":"done|unsure|not_done","done":0-1,"unfinished":0-1}`

- `done`: trust it; read only the parts of the file you actually need.
- `not_done`: send it back or rerun it; don't read the whole output.
- `unsure`: read the end of the output, where results and errors usually are, before deciding.
