#!/usr/bin/env node
// live-love-jev CLI.
//   cli.js check --task <text|@file> --result <text|@file>
//   cli.js handoff <session_id> <project_dir>
//   cli.js delegate [--model m] [--session id] [--dir d] [--out file] [--task-file f] <task>
//   cli.js route <task>
//   cli.js stats
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const jev = require('./jev');

const [cmd, ...rest] = process.argv.slice(2);

function flag(name) {
  const i = rest.indexOf(`--${name}`);
  if (i < 0 || rest[i + 1] == null) return null;
  const v = rest[i + 1];
  return v.startsWith('@') ? fs.readFileSync(v.slice(1), 'utf8') : v;
}

// ---------- check: is a result done, judged against only its task ----------

async function check() {
  const task = flag('task');
  const result = flag('result');
  if (!task || !result) throw new Error('usage: check --task <text|@file> --result <text|@file>');
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
  const done = a.done.noul;
  const unfinished = a.unfinished.noul;
  const verdict = done >= 0.7 && unfinished <= 0.3 ? 'done' : done < 0.35 || unfinished > 0.7 ? 'not_done' : 'unsure';
  jev.log('cli-check', { done, unfinished, verdict });
  console.log(JSON.stringify({ verdict, done, unfinished }));
}

// ---------- handoff: pick what's worth keeping, for a /clear instead of a /compact ----------

async function handoff() {
  const [sessionId, projectDir = process.cwd()] = rest;
  const transcript = jev.loadSession(sessionId).transcript_path || newestTranscript(projectDir);
  const entries = transcript ? jev.readTranscript(transcript) : [];
  if (!entries.length) throw new Error('No transcript found for this session.');

  const prompts = entries.map(jev.userText).filter(Boolean);
  const task = prompts.slice(-3).join('\n---\n');
  const files = new Set();
  let todos = null;
  const candidates = [];
  for (const e of entries) {
    for (const b of (e.type === 'assistant' && Array.isArray(e.message?.content) && e.message.content) || []) {
      if (b.type !== 'tool_use') continue;
      if (['Edit', 'Write', 'NotebookEdit'].includes(b.name) && b.input?.file_path) files.add(b.input.file_path);
      if (b.name === 'TodoWrite' && Array.isArray(b.input?.todos)) todos = b.input.todos;
    }
    const u = jev.userText(e);
    if (u) candidates.push(`User asked: ${u}`);
    const a = jev.assistantText(e);
    if (a) for (const p of a.split(/\n\s*\n/)) if (p.trim().length > 40) candidates.push(p.trim());
  }
  const items = candidates.slice(0, -3).slice(-200).map((c) => jev.truncate(c, 800));

  let kept;
  let note = '';
  try {
    const scores = await jev.nouls({ current_task: task }, items, (item) => ({
      item,
      question:
        'Is `item` still needed to continue `current_task`, for example a decision, requirement, constraint, open problem, or key finding?',
    }));
    const ranked = items.map((text, i) => ({ text, i, s: scores[i] ?? 0 })).filter((x) => x.s >= 0.5).sort((a, b) => b.s - a.s);
    const picked = [];
    let size = 0;
    for (const x of ranked) {
      if (size + x.text.length > 6000) continue;
      picked.push(x);
      size += x.text.length;
    }
    kept = picked.sort((a, b) => a.i - b.i).map((x) => x.text);
    note = `kept ${kept.length} of ${items.length} items`;
  } catch (err) {
    kept = items.slice(-6); // Jev unavailable: fall back to the most recent items
    note = `Jev unavailable (${err.message}); kept the last ${kept.length} items`;
  }

  const md = [
    `# Handoff from previous session (${new Date().toISOString().slice(0, 16).replace('T', ' ')})`,
    'This is context carried over after /clear. Continue the current task.',
    '',
    '## Current task (latest requests)',
    jev.truncate(task, 3000),
    files.size ? `\n## Files changed\n${[...files].map((f) => `- ${f}`).join('\n')}` : '',
    todos ? `\n## Todo list\n${todos.map((t) => `- [${t.status === 'completed' ? 'x' : ' '}] ${t.content}`).join('\n')}` : '',
    kept.length ? `\n## Key context\n${kept.map((k) => `- ${k.replace(/\n/g, '\n  ')}`).join('\n')}` : '',
  ].filter((x) => x !== '').join('\n');

  fs.writeFileSync(jev.handoffFile(projectDir), jev.truncate(md, 9500));
  jev.log('handoff-save', { chars: md.length, items: items.length, kept: kept.length });
  console.log(`Handoff saved: ${md.length} chars (${note}). Run /clear to start fresh with it.`);
}

// Fallback when no session state exists: the newest transcript for this project.
function newestTranscript(projectDir) {
  const dir = path.join(os.homedir(), '.claude', 'projects', path.resolve(projectDir).replace(/[^A-Za-z0-9]/g, '-'));
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  } catch {
    return null;
  }
}

// ---------- delegate / route: OpenCode orchestration ----------

// delegate [--model m] [--session id] [--dir d] [--out file] [--task-file f] <task...>
async function delegate() {
  const opts = {};
  const words = [];
  for (let i = 0; i < rest.length; i++) {
    const m = /^--(model|session|dir|out|task-file)$/.exec(rest[i]);
    if (m) opts[m[1]] = rest[++i];
    else words.push(rest[i]);
  }
  let task = words.join(' ').trim();
  if (opts['task-file']) {
    task = fs.readFileSync(opts['task-file'], 'utf8').trim();
    fs.rmSync(opts['task-file'], { force: true });
  }
  if (!task) throw new Error('usage: delegate [--model m] [--session id] [--dir d] [--out file] [--task-file f] <task>');
  const orchestrate = require('./orchestrate');
  const r = await orchestrate.delegate({
    task,
    model: opts.model || orchestrate.CODE_MODEL,
    dir: opts.dir || process.cwd(),
    session: opts.session,
  });
  const text = orchestrate.report(r, path.join(__dirname, 'cli.js').replace(/\\/g, '/'));
  if (opts.out) fs.writeFileSync(opts.out, text);
  else console.log(text);
}

// route <task...> — show where the router would send a task (for tuning)
async function route() {
  console.log(JSON.stringify(await require('./orchestrate').route(rest.join(' '))));
}

// ---------- stats: what the plugin has saved ----------

function stats() {
  const lines = jev.readTranscript(path.join(jev.DATA_DIR, 'log.jsonl'));
  const by = (ev) => lines.filter((l) => l.event === ev);
  const filters = by('filter');
  const before = filters.reduce((n, l) => n + l.before, 0);
  const after = filters.reduce((n, l) => n + l.after, 0);
  const checks = by('subagent-check');
  const routes = by('route');
  const oc = by('opencode');
  const out = [
    `Routing: ${routes.length} subagent tasks classified — ${routes.filter((r) => r.target === 'opencode').length} to OpenCode, ${routes.filter((r) => r.target === 'claude').length} kept on Claude`,
    `OpenCode runs: ${oc.length} (${oc.filter((r) => r.verdict === 'done').length} judged done), ${oc.reduce((n, r) => n + r.tokens, 0)} OpenCode tokens, $${oc.reduce((n, r) => n + r.cost, 0).toFixed(4)}`,
    `Output filtering: ${filters.length} outputs, ${before} → ${after} chars (~${Math.round((before - after) / 4)} tokens kept out of context)`,
    `Subagent checks: ${checks.length} run, ${checks.filter((c) => c.blocked).length} sent back as unfinished`,
    `Handoffs: ${by('handoff-save').length} saved, ${by('handoff-load').length} loaded after /clear`,
    `Errors: ${by('error').length}${by('error').length ? ` (latest: ${by('error').at(-1).message})` : ''}`,
  ];
  console.log(out.join('\n'));
}

(async () => {
  try {
    const commands = { check, handoff, stats, delegate, route };
    if (!commands[cmd]) throw new Error('usage: cli.js check|handoff|delegate|route|stats');
    await commands[cmd]();
  } catch (err) {
    console.log(`live-love-jev: ${err.message}`);
    process.exitCode = 1;
  }
})();
