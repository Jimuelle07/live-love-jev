# jev-tools

A Claude Code plugin that uses TypeSafe's [Jev](https://docs.typesafe.ai/introduction) model to keep tokens out of Claude's context. It has no dependencies and needs only Node 18+.

| Feature | Runs | What it does |
|---|---|---|
| **Routing to OpenCode** | Automatically, whenever Claude spawns a generic subagent (`general-purpose`, no `model` set) | Jev classifies the task. **Implementation and routine work** runs on [OpenCode](https://opencode.ai) Go models inside the hook, and Claude gets a short report (status, files changed, summary) instead of a Claude subagent. **Hard reasoning** (design, unclear bugs, reviews, planning) stays on Claude. If OpenCode fails, the Claude subagent runs as normal. |
| **Output filter** | Automatically, after each `Bash`/`PowerShell` call | If the output is over 8,000 chars, it asks Jev which chunks matter for your current request and replaces the output with just those. Lines with errors or failures, plus the first and last chunk, are always kept. The full output is saved to a file, and its path is shown to Claude. |
| **Subagent check** | Automatically, when a subagent finishes | Jev compares the subagent's result against **only its task**, not the whole conversation. If the result looks unfinished, the subagent is sent back once with a short reason. |
| **Handoff** | `/jev-tools:handoff`, then `/clear` | Jev picks the parts of the conversation that are still needed and saves them along with the files changed and the todo list. After `/clear`, they're loaded into the new session automatically. This is much cheaper than `/compact`. |
| **Check** | Claude uses it when needed (`/jev-tools:check`) | Checks whether a saved output (a background agent, Codex, Gemini…) finished its task, without reading the whole output into context. |
| **Stats** | `/jev-tools:stats` | Shows how much each feature has done: chars filtered out, checks run, handoffs used. |

A hook also records your last 3 prompts, so the filter knows what "relevant" means. It adds nothing to the context.

## Setup (once per machine)

1. Get an API key at https://console.typesafe.ai/keys and set it as a user environment variable:
   ```powershell
   setx TYPESAFE_API_KEY "your-key"      # Windows, then restart the terminal
   ```
   ```bash
   echo 'export TYPESAFE_API_KEY="your-key"' >> ~/.bashrc   # macOS/Linux
   ```
2. Add the marketplace and install the plugin:
   ```
   claude plugin marketplace add Jimuelle07/jim-ai-workflow
   claude plugin install jev-tools@jim-ai-workflow
   ```
   This installs it for your user account, so it works in every project. To install it for a single project instead, add `--scope project`.

3. For routing: install OpenCode (`npm i -g opencode-ai`) and sign in to OpenCode Go (`opencode auth login`).
4. Restart Claude Code so it picks up the new environment variable.

## How routing decides

| Jev says | Goes to | Model |
|---|---|---|
| `think_hard`, or Jev isn't confident (< 0.4) | Claude subagent | unchanged |
| `implement`, large change | OpenCode | `JEV_OC_MODEL` (default `opencode-go/kimi-k2.7-code`) |
| `implement`, small change, or `routine` (search, summarize) | OpenCode | `JEV_OC_FAST_MODEL` (default `opencode-go/deepseek-v4.1-flash`) |

- **Forcing Claude:** set `model` on the Agent call (e.g. `"sonnet"`). Custom agent types (`Explore`, `Plan`, your own agents) are never rerouted.
- **Background runs:** a background Agent call starts OpenCode in the background. The report is written to a file whose path Claude is given.
- **Follow-ups:** each report includes a `delegate --session <id>` command, so Claude can send fixes to the same OpenCode session without re-explaining.
- **Checking the router:** `node scripts/cli.js route "<task>"` shows where a task would go, which helps with tuning.
- **Permissions:** OpenCode runs with `--auto`, so it approves its own edits and commands. Anything your OpenCode config explicitly denies stays denied.

## Safety

- **Fails open.** If there's no key, a network error, or a timeout, the hooks do nothing and Claude sees the normal output. Errors go to `~/.claude/jev-tools/log.jsonl` and show up in `/jev-tools:stats`.
- The filter never touches file-viewing commands (`cat`, `head`, `tail`, `sed`, `Get-Content`, `git diff`, `git show`), because Claude may edit files based on their exact contents.
- To skip the filter for one command, add a `# jev:raw` comment to it.
- A subagent is sent back at most once.
- Note that command output, subagent results, and your prompts are sent to TypeSafe's API.

## Tuning (optional environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `JEV_DISABLE` | – | Set to `1` to turn every hook off |
| `JEV_FILTER_MIN_CHARS` | `8000` | Only filter outputs longer than this |
| `JEV_KEEP` | `0.3` | Keep a chunk when Jev's relevance score is at or above this. Lower it to keep more. |
| `JEV_DONE_MIN` | `0.35` | Send a subagent back if its "done" score is below this |
| `JEV_UNFINISHED_MAX` | `0.7` | …or if its "unfinished" score is above this |
| `JEV_MODEL` | `jev-latest` | Pin a version, e.g. `jev-1.13.0` |
| `JEV_ROUTE` | – | Set to `off` to turn off OpenCode routing only |
| `JEV_OC_MODEL` | `opencode-go/kimi-k2.7-code` | OpenCode model for larger coding tasks |
| `JEV_OC_FAST_MODEL` | `opencode-go/deepseek-v4.1-flash` | OpenCode model for small edits and routine tasks |
| `JEV_ROUTE_MIN_CONFIDENCE` | `0.4` | Below this confidence, the task stays on Claude |
| `JEV_OC_TIMEOUT_MIN` | `25` | Stop an OpenCode run after this many minutes |
| `JEV_OPENCODE_BIN` | auto | Path to the `opencode` binary, if it isn't found automatically |
