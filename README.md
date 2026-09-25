# live-love-jev

**A Claude Code plugin that cuts token usage.** It sends coding subagent tasks to cheap [OpenCode Go](https://opencode.ai) models, keeps Claude for hard reasoning, and trims what reaches Claude's context. [TypeSafe Jev](https://docs.typesafe.ai/introduction) makes each decision in about a second.

[![test](https://github.com/Jimuelle07/live-love-jev/actions/workflows/test.yml/badge.svg)](https://github.com/Jimuelle07/live-love-jev/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node 18+](https://img.shields.io/badge/node-%3E%3D18-339933)](https://nodejs.org)

## What it does

| | |
|---|---|
| **Routes subagents** | Coding and routine tasks run on OpenCode Go, and Claude gets a short report. Design, debugging and review stay on Claude. |
| **Filters output** | Long test, build and log output is cut to the parts relevant to your task. In testing, 41k chars went to Claude as 7.6k. |
| **Checks subagents** | Each result is judged against its task alone, and unfinished work is sent back once. |
| **Hands off context** | `/live-love-jev:handoff` then `/clear` carries only what's still needed into a new session. It's cheaper than `/compact`. |

Everything runs automatically through hooks. There are no dependencies, and if Jev or OpenCode is down, Claude Code works as usual.

## Install

You need Claude Code, Node 18+, a [TypeSafe API key](https://console.typesafe.ai/keys), and [OpenCode Go](https://opencode.ai) for routing.

```bash
setx TYPESAFE_API_KEY "your-key"        # macOS/Linux: export it in your shell profile
npm i -g opencode-ai && opencode auth login

claude plugin marketplace add Jimuelle07/live-love-jev
claude plugin install live-love-jev@live-love-jev
```

Restart Claude Code afterwards.

## Use

- **Automatic:** you don't need to do anything. Delegating coding work to subagents saves the most tokens.
- **Commands:** `/live-love-jev:handoff`, `/live-love-jev:delegate <task>`, `/live-love-jev:check`, `/live-love-jev:stats`.
- **Keeping a task on Claude:** ask for a specific model (e.g. "use a sonnet subagent").

See the [plugin reference](plugins/live-love-jev/README.md) for routing rules, settings and safety details.

## License

[MIT](LICENSE)
