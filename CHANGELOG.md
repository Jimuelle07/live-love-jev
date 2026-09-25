# Changelog

## 0.2.0 — 2026-09-25

- Renamed the plugin and marketplace from `jev-tools` to `live-love-jev`. Commands are now `/live-love-jev:*`, and data now lives in `~/.claude/live-love-jev/`.
- **Added:**
  - Routing of generic subagent tasks: coding and routine work runs on OpenCode Go models, and hard reasoning stays on Claude.
  - `/live-love-jev:delegate`, to send a task to OpenCode on purpose.
  - A test suite (`npm test`) and CI on Linux, macOS and Windows.
  - Automatic cleanup: old outputs and session files are deleted, and the log is rotated.
- **Fixed:**
  - Long tasks are sent to OpenCode as a file, so they don't hit Windows' command-line length limit.
  - Very large command output is capped at 400 scored chunks.
  - Setting a tuning variable to `0` now works.

## 0.1.0 — 2026-09-25

- First release: output filter, subagent check, handoff, check, and stats.
