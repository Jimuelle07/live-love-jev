// Shared helpers: Jev client, per-session state, transcript parsing, logging.
// Zero dependencies — needs Node 18+ (global fetch).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const API_URL = process.env.JEV_API_URL || 'https://api.typesafe.ai/v1/systemone';
const MODEL = process.env.JEV_MODEL || 'jev-latest';
// Stays under Jev's 64k-token request budget (~3.5 chars per token).
const BATCH_CHARS = 120000;
const BATCH_QUESTIONS = 100;

const DATA_DIR = path.join(os.homedir(), '.claude', 'jev-tools');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Jev API ----------

async function ask(state, questions, { timeoutMs = 20000 } = {}) {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error('TYPESAFE_API_KEY is not set');
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, model: MODEL, questions }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if ((res.status === 429 || res.status === 529) && attempt < 2) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 500 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(wait, 4000)));
      continue;
    }
    if (!res.ok) throw new Error(`Jev ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()).answers;
  }
}

// Ask one Noul per item against a shared state, batching to fit request limits.
// makeInstructions(item) returns the question's `instructions`. Returns a number per item.
async function nouls(state, items, makeInstructions, opts) {
  const batches = [[]];
  let size = 0;
  items.forEach((item, i) => {
    const q = makeInstructions(item);
    const len = JSON.stringify(q).length;
    const cur = batches[batches.length - 1];
    if (cur.length && (size + len > BATCH_CHARS || cur.length >= BATCH_QUESTIONS)) {
      batches.push([]);
      size = 0;
    }
    batches[batches.length - 1].push([i, q]);
    size += len;
  });
  const out = new Array(items.length).fill(null);
  await Promise.all(
    batches.map(async (batch) => {
      const questions = {};
      for (const [i, q] of batch) questions[`q${i}`] = { type: 'noul', instructions: q };
      const answers = await ask(state, questions, opts);
      for (const [i] of batch) out[i] = answers[`q${i}`]?.noul ?? null;
    })
  );
  return out;
}

// ---------- State ----------

const sessionFile = (id) => path.join(DATA_DIR, `session-${String(id).replace(/[^\w-]/g, '')}.json`);
const projectKey = (dir) =>
  crypto.createHash('sha1').update(path.resolve(dir || '.').toLowerCase()).digest('hex').slice(0, 12);
const handoffFile = (projectDir) => path.join(DATA_DIR, `handoff-${projectKey(projectDir)}.md`);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadSession(id) {
  return readJson(sessionFile(id), { prompts: [] });
}

function saveSession(id, data) {
  fs.writeFileSync(sessionFile(id), JSON.stringify(data));
}

// Recent user prompts, newest last — used as "the task" for relevance questions.
function currentTask(sessionId, maxChars = 3000) {
  const text = loadSession(sessionId).prompts.join('\n---\n');
  return text.slice(-maxChars);
}

// ---------- Transcript ----------

function readTranscript(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Text a human typed (not tool results, not system/command wrappers).
function userText(entry) {
  if (entry.type !== 'user' || !entry.message || entry.isMeta) return null;
  const c = entry.message.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
  if (!text.trim() || text.trimStart().startsWith('<')) return null;
  return text.trim();
}

function assistantText(entry) {
  if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) return null;
  const text = entry.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return text.trim() || null;
}

// The prompt a subagent was given = first user message in its own transcript.
function subagentTask(agentTranscriptPath) {
  for (const e of readTranscript(agentTranscriptPath)) {
    const t = userText(e);
    if (t) return t;
  }
  return null;
}

// Subagent transcripts live at <session transcript without .jsonl>/subagents/agent-<id>.jsonl
function subagentTranscriptPath(transcriptPath, agentId) {
  return path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents', `agent-${agentId}.jsonl`);
}

// ---------- Misc ----------

function log(event, data) {
  try {
    fs.appendFileSync(path.join(DATA_DIR, 'log.jsonl'), JSON.stringify({ t: new Date().toISOString(), event, ...data }) + '\n');
  } catch {}
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => resolve(buf));
  });
}

const truncate = (s, n) => (s.length > n ? s.slice(0, n) + `… [+${s.length - n} chars]` : s);

module.exports = {
  DATA_DIR, ask, nouls, loadSession, saveSession, currentTask, handoffFile,
  readTranscript, userText, assistantText, subagentTask, subagentTranscriptPath,
  log, readStdin, truncate,
};
