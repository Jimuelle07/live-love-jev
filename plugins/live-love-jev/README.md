# live-love-jev reference

For install steps, see the [main README](../../README.md).

## Hooks

| Event | What happens |
|---|---|
| `SessionStart` | Adds a two-sentence note about routing. After `/clear`, it also loads a saved handoff (once). |
| `UserPromptSubmit` | Saves your last 3 prompts as "the current task". Adds nothing to context. |
| `PreToolUse` on `Agent` | Routes the subagent task (see below). |
| `PostToolUse` on `Bash`/`PowerShell` | Filters output over 8,000 chars. |
| `SubagentStop` | Checks the result against the subagent's task and sends unfinished work back once. |

## Routing

Only generic subagents are routed: `general-purpose`, with no `model` set. Jev classifies the task:

| Jev says | Runs on |
|---|---|
| `think_hard`, or confidence below 0.4 | Claude, unchanged |
| `implement`, large change | OpenCode: `opencode-go/kimi-k2.7-code` |
| `implement`, small change, or `routine` | OpenCode: `opencode-go/deepseek-v4.1-flash` |

- **Report:** Claude receives the status, the files changed, OpenCode's summary, and a `--session` command for follow-ups.
- **Background:** a background agent runs OpenCode in the background. The report is written to a file whose path Claude is given.
- **Fallback:** if OpenCode fails, the Claude subagent runs instead.
- **Permissions:** OpenCode runs with `--auto`, so it approves its own edits and commands unless your OpenCode config denies them.

To see where a task would go, run `node scripts/cli.js route "<task>"`.

## Output filter

- **How it works:** output is split into 12-line chunks, and Jev scores each one for relevance to the current task.
- **Always kept:** chunks with error, failure or warning lines, plus the first and last chunk.
- **Full output:** saved to a file, and Claude is given the path.
- **Never filtered:** file-viewing commands (`cat`, `head`, `tail`, `sed`, `Get-Content`, `git diff`, `git show`). Add `# jev:raw` to any command to skip the filter.

## Commands

| Command | What it does |
|---|---|
| `/live-love-jev:handoff` | Saves the context that's still needed. Run `/clear` next. |
| `/live-love-jev:delegate <task>` | Sends a task to OpenCode on purpose. |
| `/live-love-jev:check` | Tells whether a saved output finished its task, without reading all of it. |
| `/live-love-jev:stats` | Shows routing, OpenCode cost, and filter savings. |

## Settings

These are all optional environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `JEV_DISABLE` | – | `1` turns off every hook |
| `JEV_ROUTE` | – | `off` turns off routing only |
| `JEV_OC_MODEL` | `opencode-go/kimi-k2.7-code` | Model for larger coding tasks |
| `JEV_OC_FAST_MODEL` | `opencode-go/deepseek-v4.1-flash` | Model for small and routine tasks |
| `JEV_ROUTE_MIN_CONFIDENCE` | `0.4` | Below this, the task stays on Claude |
| `JEV_OC_TIMEOUT_MIN` | `25` | Stops an OpenCode run after this many minutes |
| `JEV_OPENCODE_BIN` | auto | Path to `opencode`, if it isn't found |
| `JEV_FILTER_MIN_CHARS` | `8000` | Only filter output longer than this |
| `JEV_KEEP` | `0.3` | Relevance score needed to keep a chunk. Lower keeps more. |
| `JEV_DONE_MIN` | `0.35` | Sends a subagent back if its "done" score is below this… |
| `JEV_UNFINISHED_MAX` | `0.7` | …or its "unfinished" score is above this |
| `JEV_MODEL` | `jev-latest` | Jev model version |
| `JEV_DATA_DIR` | `~/.claude/live-love-jev` | Where logs, outputs and handoffs are kept |

## Safety and privacy

- **Fails open.** If Jev or OpenCode errors or times out, the hook does nothing. Errors are logged and shown in `/live-love-jev:stats`.
- A subagent is sent back at most once.
- **Cleanup:** saved outputs are deleted after 2 days, and session files after 7. The log rotates at 5 MB.
- **Where data goes:** prompts, command output and subagent results are sent to TypeSafe's API, and coding tasks are sent to OpenCode.

## Development

```bash
npm test                                   # end-to-end tests with a mock Jev and a fake OpenCode
claude plugin validate plugins/live-love-jev
```
