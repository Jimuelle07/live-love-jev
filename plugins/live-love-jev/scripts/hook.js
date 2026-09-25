// Single entry point for every live-love-jev hook. Dispatches on hook_event_name.
// Fails open: any error means "do nothing", so Claude Code behaves as if the hook weren't there.
'use strict';
const fs = require('fs');
const path = require('path');
const jev = require('./jev');
const orchestrate = require('./orchestrate');

const FILTER_MIN_CHARS = jev.envNum('JEV_FILTER_MIN_CHARS', 8000);
const KEEP_THRESHOLD = jev.envNum('JEV_KEEP', 0.3);
const DONE_MIN = jev.envNum('JEV_DONE_MIN', 0.35);
const UNFINISHED_MAX = jev.envNum('JEV_UNFINISHED_MAX', 0.7);
// Upper bound on chunks scored per output (~4,800 lines). Older chunks beyond it are dropped
// unless they contain error lines; the full output is always saved to a file.
const MAX_SCORED_CHUNKS = 400;

// Commands whose output Claude may edit from verbatim — never filter these.
const SKIP_CMD = /^\s*(cat|head|tail|less|more|type|sed|awk|nl|bat|Get-Content|gc)\b|\bgit\s+(diff|show)\b|jev:raw/i;
// Lines code can recognise as important without asking a model.
const ALWAYS_KEEP = /\b(error|errors|fail|failed|failure|failing|exception|traceback|panic|fatal|warn|warning|assert\w*)\b|✗|✖|×/i;

const emit = (obj) => process.stdout.write(JSON.stringify(obj));

// UserPromptSubmit: remember recent prompts so other hooks know the current task. Adds no tokens.
function onPrompt(input) {
  const prompt = (input.prompt || '').trim();
  if (!prompt || prompt.startsWith('/')) return;
  const s = jev.loadSession(input.session_id);
  s.prompts = [...s.prompts, jev.truncate(prompt, 1500)].slice(-3);
  s.transcript_path = input.transcript_path;
  s.project_dir = process.env.CLAUDE_PROJECT_DIR || input.cwd;
  jev.saveSession(input.session_id, s);
}

// PostToolUse (Bash/PowerShell): replace long output with only the chunks relevant to the task.
async function onToolOutput(input) {
  const resp = input.tool_response;
  const command = String(input.tool_input?.command || '');
  if (!resp || typeof resp.stdout !== 'string' || resp.stdout.length < FILTER_MIN_CHARS) return;
  if (SKIP_CMD.test(command)) return;

  const task = input.agent_id
    ? jev.subagentTask(jev.subagentTranscriptPath(input.transcript_path, input.agent_id))
    : jev.currentTask(input.session_id);
  if (!task) return;

  const chunks = chunkLines(resp.stdout.split('\n'), 12, 1200);
  const keep = chunks.map((c, i) => i === 0 || i === chunks.length - 1 || ALWAYS_KEEP.test(c.text));
  const unscored = chunks.map((_, i) => i).filter((i) => !keep[i]);
  const toScore = unscored.slice(-MAX_SCORED_CHUNKS); // the end of a log is usually what matters
  const scores = await jev.nouls({ task, command: jev.truncate(command, 500) }, toScore, (i) => ({
    output_chunk: chunks[i].text,
    question: 'Does `output_chunk` contain information needed to complete `task`?',
  }));
  toScore.forEach((i, j) => {
    keep[i] = (scores[j] ?? 1) >= KEEP_THRESHOLD; // no score → keep
  });

  const parts = [];
  let omitted = 0;
  chunks.forEach((c, i) => {
    if (keep[i]) {
      if (omitted) parts.push(`[… ${omitted} lines omitted by live-love-jev …]`);
      omitted = 0;
      parts.push(c.text);
    } else omitted += c.lines;
  });
  const filtered = parts.join('\n');
  const before = resp.stdout.length;
  if (filtered.length > before * 0.7) return; // not worth replacing

  const saved = saveFullOutput(input.tool_use_id, resp.stdout);
  const footer = `\n[live-love-jev kept ${filtered.length} of ${before} chars. Full output: ${saved} — read it if something looks missing.]`;
  jev.log('filter', { session: input.session_id, command: jev.truncate(command, 120), before, after: filtered.length });
  emit({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { ...resp, stdout: filtered + footer } } });
}

function chunkLines(lines, maxLines, maxChars) {
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const line of lines) {
    if (cur.length && (cur.length >= maxLines || size + line.length > maxChars)) {
      chunks.push({ text: cur.join('\n'), lines: cur.length });
      cur = [];
      size = 0;
    }
    cur.push(line.length > maxChars ? line.slice(0, maxChars) + '…' : line);
    size += line.length;
  }
  if (cur.length) chunks.push({ text: cur.join('\n'), lines: cur.length });
  return chunks;
}

function saveFullOutput(id, text) {
  const file = path.join(jev.OUTPUTS_DIR, `${String(id || Date.now()).replace(/[^\w-]/g, '')}.txt`);
  fs.writeFileSync(file, text);
  return file.replace(/\\/g, '/');
}

// SubagentStop: judge the subagent's result against only its task — not the whole conversation.
// If it looks unfinished, send it back once with a short reason.
async function onSubagentStop(input) {
  if (input.stop_hook_active || !input.agent_type) return; // one nudge max; skip internal agents
  const entries = jev.readTranscript(input.agent_transcript_path);
  const task = entries.map(jev.userText).find(Boolean);
  const result = handbackMessage(entries) || input.last_assistant_message || '';
  if (!task || result.trim().length < 40) return;

  const a = await jev.ask(
    { task: jev.truncate(task, 8000), result: jev.truncate(result, 20000) },
    {
      done: { type: 'noul', instructions: 'Does `result` complete what `task` asks for?' },
      unfinished: {
        type: 'noul',
        instructions: 'Does `result` say that some of the requested work failed, was skipped, or is still unfinished?',
      },
    }
  );
  const done = a.done?.noul ?? 1;
  const unfinished = a.unfinished?.noul ?? 0;
  const incomplete = done < DONE_MIN || unfinished > UNFINISHED_MAX;
  jev.log('subagent-check', { agent: input.agent_type, done, unfinished, blocked: incomplete });
  if (!incomplete) return;
  emit({
    decision: 'block',
    reason:
      `live-love-jev check: this result may not fully complete the task (done=${done.toFixed(2)}, unfinished=${unfinished.toFixed(2)}). ` +
      'Finish the remaining work. If something cannot be done, say exactly what is missing and why, then stop.',
  });
}

// Newer Claude Code versions deliver a subagent's report through a SubagentHandback tool call.
function handbackMessage(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const blocks = entries[i].type === 'assistant' ? entries[i].message?.content : null;
    const hb = Array.isArray(blocks) && blocks.find((b) => b.type === 'tool_use' && b.name === 'SubagentHandback');
    if (hb) return String(hb.input?.message || '');
  }
  return null;
}

// PreToolUse (Agent): Jev routes generic subagent tasks. Coding and routine work runs on OpenCode
// inside this hook, and Claude gets a short report as the "denial" reason instead of a Claude subagent.
// Hard-reasoning tasks, custom agent types, and calls with an explicit `model` go to Claude untouched.
const GENERIC_AGENTS = new Set(['', 'general-purpose', 'claude']);

async function onAgent(input) {
  const ti = input.tool_input || {};
  if (process.env.JEV_ROUTE === 'off' || ti.model || !GENERIC_AGENTS.has(ti.subagent_type || '') || !ti.prompt) return;
  const r = await orchestrate.route(`${ti.description || ''}\n${ti.prompt}`);
  jev.log('route', { target: r.target, kind: r.kind, confidence: r.confidence, model: r.model || null });
  if (r.target !== 'opencode') return;

  const dir = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const cli = path.join(__dirname, 'cli.js').replace(/\\/g, '/');
  let reason;
  if (ti.run_in_background) {
    const id = `opencode-${Date.now()}`;
    const out = path.join(jev.OUTPUTS_DIR, `${id}.md`).replace(/\\/g, '/');
    const taskFile = path.join(jev.OUTPUTS_DIR, `${id}.task.txt`);
    fs.writeFileSync(taskFile, ti.prompt); // a file, not argv: prompts can exceed command-line limits
    const { spawn } = require('child_process');
    spawn(process.execPath, [cli, 'delegate', '--model', r.model, '--dir', dir, '--out', out, '--task-file', taskFile], {
      detached: true, stdio: 'ignore', windowsHide: true,
    }).unref();
    reason = `[live-love-jev] Delegated to OpenCode (${r.model}) in the background instead of a Claude subagent. Its report will be written to ${out} when it finishes; read that file to get the result.`;
  } else {
    const result = await orchestrate.delegate({ task: ti.prompt, model: r.model, dir });
    if (result.verdict === 'failed') return; // OpenCode couldn't run: let the Claude subagent do it
    reason = orchestrate.report(result, cli);
  }
  emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}

// SessionStart: describe the routing (every session), and load a handoff after /clear (once).
const ROUTING_NOTE =
  'live-love-jev routing is active. Agent calls with the default subagent type and no `model` are classified by Jev: ' +
  'implementation and routine tasks run on OpenCode Go models (much cheaper) and return a short report; ' +
  'tasks that need hard reasoning run on Claude. Delegating coding work to subagents is cheaper than writing large changes in the main session. ' +
  'Setting `model` (e.g. "opus" or "sonnet") on an Agent call always keeps it on Claude.';

function onSessionStart(input) {
  jev.housekeeping();
  const context = [];
  if (process.env.JEV_ROUTE !== 'off') context.push(ROUTING_NOTE);
  const file = jev.handoffFile(process.env.CLAUDE_PROJECT_DIR || input.cwd);
  if (input.source === 'clear' && fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < 6 * 3600 * 1000) {
    const text = fs.readFileSync(file, 'utf8');
    fs.renameSync(file, file.replace(/\.md$/, '.used.md'));
    jev.log('handoff-load', { chars: text.length });
    context.push(text);
  }
  if (context.length) emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context.join('\n\n') } });
}

(async () => {
  try {
    if (process.env.JEV_DISABLE === '1') return;
    const input = JSON.parse(await jev.readStdin());
    const handlers = {
      UserPromptSubmit: onPrompt,
      PreToolUse: onAgent,
      PostToolUse: onToolOutput,
      SubagentStop: onSubagentStop,
      SessionStart: onSessionStart,
    };
    await handlers[input.hook_event_name]?.(input);
  } catch (err) {
    jev.log('error', { message: String(err?.message || err) });
  }
})();
