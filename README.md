# jim-ai-workflow

My personal Claude Code plugin marketplace.

## Plugins

### [jev-tools](plugins/jev-tools)

This plugin cuts Claude Code token use by giving small, well-defined decisions to TypeSafe's [Jev](https://docs.typesafe.ai/introduction) model and giving coding work to cheaper [OpenCode](https://opencode.ai) Go models.

| Feature | What it does |
|---|---|
| **Routing** | When Claude spawns a subagent, Jev classifies the task. Coding and routine work runs on OpenCode Go models, and Claude gets a short report back. Hard-reasoning work stays on Claude. |
| **Output filter** | Long command output (test runs, builds, logs) is cut down to the chunks relevant to the current task before Claude sees it. |
| **Subagent check** | A subagent's result is judged against its task alone, and the subagent is sent back once if the result looks unfinished. |
| **Handoff** | `/jev-tools:handoff`, then `/clear`, carries only the context that's still needed into a fresh session. It's a cheaper alternative to `/compact`. |
| **Check** | `/jev-tools:check` tells whether another model's output finished its task, without reading all of it. |
| **Stats** | `/jev-tools:stats` shows routing decisions, OpenCode cost, and output savings. |

It needs no npm install, only Node 18+. If Jev or OpenCode is unavailable, Claude Code works as usual.

## Install

```bash
# 1. Jev API key (https://console.typesafe.ai/keys)
setx TYPESAFE_API_KEY "your-key"                        # Windows
echo 'export TYPESAFE_API_KEY="your-key"' >> ~/.bashrc  # macOS/Linux

# 2. OpenCode, for routing (optional)
npm i -g opencode-ai
opencode auth login        # sign in to OpenCode Go

# 3. The plugin (installs for your user account, so it works in every project)
claude plugin marketplace add Jimuelle07/jim-ai-workflow
claude plugin install jev-tools@jim-ai-workflow
```

Restart Claude Code afterwards. See the [jev-tools README](plugins/jev-tools/README.md) for how routing decides, tuning options, and safety notes.

## Update

```bash
claude plugin marketplace update jim-ai-workflow
```
