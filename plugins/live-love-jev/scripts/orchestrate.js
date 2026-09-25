// Orchestration: Jev decides where a subagent task goes; OpenCode runs the coding work.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const jev = require('./jev');

const CODE_MODEL = process.env.JEV_OC_MODEL || 'opencode-go/kimi-k2.7-code';
const FAST_MODEL = process.env.JEV_OC_FAST_MODEL || 'opencode-go/deepseek-v4.1-flash';
const MIN_CONFIDENCE = jev.envNum('JEV_ROUTE_MIN_CONFIDENCE', 0.4);
const RUN_TIMEOUT_MS = jev.envNum('JEV_OC_TIMEOUT_MIN', 25) * 60 * 1000;
// Longer tasks are passed to OpenCode as an attached file: Windows caps a command line at ~32k chars.
const INLINE_TASK_MAX = 8000;

// Ask Jev what kind of task this is. Returns { target: 'opencode'|'claude', model?, kind, confidence }.
async function route(task) {
  const a = await jev.ask(
    { task: jev.truncate(task, 12000) },
    {
      kind: {
        type: 'choice',
        instructions: 'What kind of work does `task` ask for?',
        criteria: {
          implement: {
            what: 'Clear coding work: write, change, refactor, or delete code, add tests, fix a bug whose cause is known, run build or test commands',
            examples: ['Add a --verbose flag to the CLI', 'Write unit tests for utils/date.ts', 'Rename getUser to fetchUser everywhere'],
          },
          routine: {
            what: 'Routine non-coding work: find files, search the codebase, read and summarize code or docs, collect facts',
            examples: ['Find every place we call the payments API', 'List the env vars this service reads'],
          },
          think_hard: {
            what: 'Work that needs careful reasoning: architecture or design decisions, debugging an unclear root cause, reviewing code for bugs or security issues, planning a multi-step change, or unclear requirements',
            not_for: 'Straightforward implementation, even if it is long',
            examples: ['Figure out why requests hang intermittently in prod', 'Review this PR for race conditions', 'Design the caching layer'],
          },
        },
      },
      size: {
        type: 'score',
        instructions: 'How much code will `task` likely change?',
        criteria: ['None or a few lines in one file', 'Changes across a few files', 'A new feature or changes across many files'],
      },
    }
  );
  const kind = a.kind.choice;
  const confidence = a.kind.confidence;
  if (kind === 'think_hard' || confidence < MIN_CONFIDENCE) return { target: 'claude', kind, confidence };
  const model = kind === 'routine' || a.size.score < 0.5 ? FAST_MODEL : CODE_MODEL;
  return { target: 'opencode', model, kind, confidence, size: a.size.score };
}

// Locate the real opencode binary. On Windows npm installs a .ps1/.cmd shim, which can't be spawned without a shell.
// Returns [command, leadingArgs]; a .js override runs under Node (used by the test suite).
function opencodeBin() {
  const custom = process.env.JEV_OPENCODE_BIN;
  if (custom) return custom.endsWith('.js') ? [process.execPath, [custom]] : [custom, []];
  if (process.platform === 'win32' && process.env.APPDATA) {
    const exe = path.join(process.env.APPDATA, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
    if (fs.existsSync(exe)) return [exe, []];
  }
  return ['opencode', []];
}

// Run one OpenCode task headlessly and summarise what it did.
function runOpencode({ task, model, dir, session }) {
  const args = ['run', '--format', 'json', '--auto', '--dir', dir, '-m', model];
  if (session) args.push('-s', session);
  let taskFile = null;
  if (task.length > INLINE_TASK_MAX) {
    taskFile = path.join(jev.OUTPUTS_DIR, `task-${Date.now()}.md`);
    fs.writeFileSync(taskFile, task);
    args.push('-f', taskFile, '--', 'Do the task described in the attached file.');
  } else {
    args.push('--', task);
  }
  return new Promise((resolve) => {
    // stdin must be closed: `opencode run` waits for piped stdin to end before starting.
    const [bin, lead] = opencodeBin();
    const child = spawn(bin, [...lead, ...args], { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);
    child.on('error', (e) => (err += e.message));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (taskFile) fs.rm(taskFile, () => {});
      const r = { model, text: [], files: new Set(), tokens: 0, cost: 0, sessionId: session || null, code };
      for (const line of out.split('\n')) {
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        r.sessionId = e.sessionID || r.sessionId;
        const p = e.part || {};
        if (e.type === 'text' && p.text) r.text.push(p.text);
        if (e.type === 'tool_use' && ['write', 'edit', 'patch', 'multiedit'].includes(p.tool)) {
          const f = p.state?.input?.filePath || p.state?.metadata?.filepath;
          if (f) r.files.add(path.relative(dir, f) || f);
        }
        if (e.type === 'step_finish') {
          r.tokens += p.tokens?.total || 0;
          r.cost += p.cost || 0;
        }
      }
      r.text = r.text.join('\n').trim();
      r.files = [...r.files];
      r.error = code === 0 ? null : jev.truncate(err.trim() || `opencode exited with code ${code}`, 800);
      resolve(r);
    });
  });
}

// Run the task on OpenCode, then have Jev judge the result against the task alone.
async function delegate({ task, model, dir, session }) {
  const started = Date.now();
  const r = await runOpencode({ task, model, dir, session });
  let verdict = 'unknown';
  if (!r.error && r.text) {
    try {
      const a = await jev.ask(
        { task: jev.truncate(task, 8000), result: jev.truncate(`${r.text}\nFiles changed: ${r.files.join(', ') || 'none'}`, 20000) },
        {
          done: { type: 'noul', instructions: 'Does `result` complete what `task` asks for?' },
          unfinished: { type: 'noul', instructions: 'Does `result` say that some of the requested work failed, was skipped, or is still unfinished?' },
        }
      );
      verdict = a.done.noul >= 0.6 && a.unfinished.noul <= 0.4 ? 'done' : 'maybe_incomplete';
    } catch {}
  }
  r.verdict = r.error ? 'failed' : verdict;
  r.seconds = Math.round((Date.now() - started) / 1000);
  jev.log('opencode', { model: r.model, verdict: r.verdict, tokens: r.tokens, cost: r.cost, seconds: r.seconds, files: r.files.length });
  return r;
}

// The compact report Claude reads instead of a subagent transcript.
function report(r, cliPath) {
  const follow = r.sessionId
    ? `To follow up in the same OpenCode session: node "${cliPath}" delegate --session ${r.sessionId} "<instructions>"`
    : '';
  return [
    `[live-love-jev] This task was delegated to OpenCode (${r.model}) instead of a Claude subagent. It already ran — do not re-run it.`,
    `Status: ${r.verdict}${r.error ? ` — ${r.error}` : ''} · ${r.seconds}s · ${r.tokens} OpenCode tokens`,
    `Files changed: ${r.files.length ? r.files.join(', ') : 'none'}`,
    '',
    'OpenCode report:',
    jev.truncate(r.text || '(no text)', 6000),
    '',
    'Review the changed files before relying on them.',
    follow,
    r.verdict !== 'done' ? 'If this is not good enough, redo it with a Claude subagent by passing an explicit `model` (e.g. "sonnet").' : '',
  ].filter(Boolean).join('\n');
}

module.exports = { route, delegate, report, CODE_MODEL, FAST_MODEL };
