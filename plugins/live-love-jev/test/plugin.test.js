// End-to-end tests: run the real hook and CLI scripts against a mock Jev server and a fake OpenCode.
// Run with: npm test
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-love-jev-test-'));
const project = path.join(tmp, 'project');
fs.mkdirSync(project);
let server;
let env;

// Mock Jev. Nouls score 0.9 when their data mentions "auth"; "TODO" in a result means unfinished;
// routing says think_hard for "why"/"design" tasks and implement otherwise.
function answer(body) {
  const answers = {};
  const task = JSON.stringify(body.state.task || '');
  const result = JSON.stringify(body.state.result || '');
  for (const [id, q] of Object.entries(body.questions)) {
    if (id === 'kind') {
      const hard = /why|design/i.test(task);
      answers[id] = { type: 'choice', choice: hard ? 'think_hard' : 'implement', confidence: 0.95, probabilities: {} };
    } else if (id === 'size') answers[id] = { type: 'score', score: 1.5, confidence: 0.9 };
    else if (id === 'done') answers[id] = { type: 'noul', noul: /TODO/.test(result) ? 0.1 : 0.95 };
    else if (id === 'unfinished') answers[id] = { type: 'noul', noul: /TODO/.test(result) ? 0.9 : 0.05 };
    else answers[id] = { type: 'noul', noul: /auth/i.test(JSON.stringify(q.instructions)) ? 0.9 : 0.05 };
  }
  return { model: 'mock', answers, usage: {} };
}

before(async () => {
  server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => res.end(JSON.stringify(answer(JSON.parse(b)))));
  });
  await new Promise((r) => server.listen(0, r));
  env = {
    ...process.env,
    TYPESAFE_API_KEY: 'test-key',
    JEV_API_URL: `http://127.0.0.1:${server.address().port}`,
    JEV_DATA_DIR: path.join(tmp, 'data'),
    JEV_OPENCODE_BIN: path.join(__dirname, 'fake-opencode.js'),
    CLAUDE_PROJECT_DIR: project,
  };
  delete env.JEV_DISABLE;
  delete env.JEV_ROUTE;
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function run(script, { args = [], input, extraEnv = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS, script), ...args], { env: { ...env, ...extraEnv } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(input ? JSON.stringify(input) : '');
  });
}
const hook = (input, extraEnv) => run('hook.js', { input, extraEnv });
const parse = (out) => (out ? JSON.parse(out) : null);

async function setTask(sessionId, prompt) {
  await hook({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt, cwd: project });
}

function testLog() {
  const lines = [];
  for (let i = 0; i < 600; i++) {
    lines.push(i % 100 === 50 ? `  auth/login.spec.js:${i} expected 200 got 401` : `  ok ${i} unrelated test in module_${i % 17} ..........`);
  }
  lines[300] = '1 test FAILED';
  return lines.join('\n');
}

const bash = (command, stdout) => ({
  hook_event_name: 'PostToolUse',
  session_id: 's1',
  tool_name: 'Bash',
  tool_use_id: 'toolu_test',
  tool_input: { command },
  tool_response: { stdout, stderr: '', interrupted: false, isImage: false },
});

test('output filter keeps relevant chunks and error lines, and preserves the output shape', async () => {
  await setTask('s1', 'fix the failing auth login test');
  const { out } = await hook(bash('npm test', testLog()));
  const replaced = parse(out).hookSpecificOutput.updatedToolOutput;
  assert.deepStrictEqual(Object.keys(replaced).sort(), ['interrupted', 'isImage', 'stderr', 'stdout']);
  assert.match(replaced.stdout, /auth\/login\.spec\.js:50/);
  assert.match(replaced.stdout, /1 test FAILED/);
  assert.match(replaced.stdout, /lines omitted by live-love-jev/);
  assert.ok(replaced.stdout.length < testLog().length / 3, 'output should shrink a lot');
  const saved = /Full output: (\S+\.txt)/.exec(replaced.stdout)[1];
  assert.strictEqual(fs.readFileSync(saved, 'utf8'), testLog());
});

test('output filter leaves short output and file-viewing commands alone', async () => {
  await setTask('s1', 'fix the failing auth login test');
  assert.strictEqual((await hook(bash('npm test', 'short output'))).out, '');
  assert.strictEqual((await hook(bash('cat big.log', testLog()))).out, '');
  assert.strictEqual((await hook(bash('npm test # jev:raw', testLog()))).out, '');
});

test('subagent check sends an unfinished result back once, and lets finished work through', async () => {
  const transcript = path.join(tmp, 'agent-a1.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'Add validation and tests to the signup form.' } }) + '\n');
  const stop = (msg, active = false) => ({
    hook_event_name: 'SubagentStop', agent_type: 'general-purpose', agent_transcript_path: transcript,
    stop_hook_active: active, last_assistant_message: msg,
  });
  const unfinished = 'Added validation for email and password. TODO: tests are not written yet.';
  assert.strictEqual(parse((await hook(stop(unfinished))).out).decision, 'block');
  assert.strictEqual((await hook(stop(unfinished, true))).out, '');
  assert.strictEqual((await hook(stop('Added validation for email and password and 6 passing tests in signup.test.ts.'))).out, '');
});

const agent = (prompt, extra = {}) => ({
  hook_event_name: 'PreToolUse', tool_name: 'Agent', cwd: project,
  tool_input: { description: 'task', subagent_type: 'general-purpose', prompt, ...extra },
});

test('routing sends implementation work to OpenCode and returns a short report', async () => {
  const { out } = await hook(agent('Add a multiply function to math.js with tests'));
  const o = parse(out).hookSpecificOutput;
  assert.strictEqual(o.permissionDecision, 'deny');
  assert.match(o.permissionDecisionReason, /delegated to OpenCode/);
  assert.match(o.permissionDecisionReason, /Files changed: generated\.js/);
  assert.match(o.permissionDecisionReason, /--session ses_fake/);
  assert.ok(fs.existsSync(path.join(project, 'generated.js')));
});

test('routing keeps hard reasoning, explicit models, and custom agents on Claude', async () => {
  assert.strictEqual((await hook(agent('Figure out why websockets drop in production'))).out, '');
  assert.strictEqual((await hook(agent('Add a multiply function', { model: 'sonnet' }))).out, '');
  assert.strictEqual((await hook(agent('Add a multiply function', { subagent_type: 'Explore' }))).out, '');
  assert.strictEqual((await hook(agent('Add a multiply function'), { JEV_ROUTE: 'off' })).out, '');
});

test('routing falls back to the Claude subagent when OpenCode fails', async () => {
  assert.strictEqual((await hook(agent('Add a multiply function'), { FAKE_OC_FAIL: '1' })).out, '');
});

test('long tasks are passed to OpenCode as a file, not on the command line', async () => {
  const { out } = await hook(agent('Add a multiply function. ' + 'Details. '.repeat(2000)));
  assert.match(parse(out).hookSpecificOutput.permissionDecisionReason, /delegated to OpenCode/);
  assert.match(fs.readFileSync(path.join(project, 'generated.js'), 'utf8'), /attached file/);
});

test('every hook fails open without an API key', async () => {
  await setTask('s1', 'fix the failing auth login test');
  assert.strictEqual((await hook(bash('npm test', testLog()), { TYPESAFE_API_KEY: '' })).out, '');
  assert.strictEqual((await hook(agent('Add a multiply function'), { TYPESAFE_API_KEY: '' })).out, '');
});

test('handoff is saved, loaded once after /clear, and the routing note is added', async () => {
  const transcript = path.join(tmp, 'main.jsonl');
  const lines = [
    { type: 'user', message: { role: 'user', content: 'Build the auth login page' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'We decided the auth tokens live in httpOnly cookies, not localStorage.' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/p/login.tsx' } }] } },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'Injected system text' } },
    { type: 'user', message: { role: 'user', content: 'Now add the logout button' } },
  ];
  fs.writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n'));
  await hook({ hook_event_name: 'UserPromptSubmit', session_id: 'h1', prompt: 'Now add the logout button', transcript_path: transcript, cwd: project });

  const saved = await run('cli.js', { args: ['handoff', 'h1', project] });
  assert.match(saved.out, /Handoff saved/);
  const first = parse((await hook({ hook_event_name: 'SessionStart', source: 'clear', cwd: project })).out);
  const context = first.hookSpecificOutput.additionalContext;
  assert.match(context, /routing is active/);
  assert.match(context, /login\.tsx/);
  assert.doesNotMatch(context, /Injected system text/);
  const second = parse((await hook({ hook_event_name: 'SessionStart', source: 'clear', cwd: project })).out);
  assert.doesNotMatch(second.hookSpecificOutput.additionalContext, /Handoff/);
});

test('cli check reports a verdict', async () => {
  const done = JSON.parse((await run('cli.js', { args: ['check', '--task', 'write tests', '--result', 'wrote 5 passing tests'] })).out);
  const notDone = JSON.parse((await run('cli.js', { args: ['check', '--task', 'write tests', '--result', 'TODO: none yet'] })).out);
  assert.strictEqual(done.verdict, 'done');
  assert.strictEqual(notDone.verdict, 'not_done');
});
