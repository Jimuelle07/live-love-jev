// Stand-in for `opencode run --format json`: writes one file and emits the JSON events the plugin parses.
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const dir = args[args.indexOf('--dir') + 1];
const task = args.slice(args.indexOf('--') + 1).join(' ');
if (process.env.FAKE_OC_FAIL) {
  console.error('model not found');
  process.exit(1);
}
const file = path.join(dir, 'generated.js');
fs.writeFileSync(file, `// ${task}\n`);
const emit = (type, part) => console.log(JSON.stringify({ type, sessionID: 'ses_fake', part }));
emit('step_start', {});
emit('tool_use', { tool: 'write', state: { status: 'completed', input: { filePath: file } } });
emit('text', { text: 'Created generated.js.' });
emit('step_finish', { tokens: { total: 1234 }, cost: 0.001 });
