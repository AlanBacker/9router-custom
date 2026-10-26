'use strict';
// The free tier matches the complete official (system, tools) template. Real
// OpenCode clients must travel untouched; other clients are mapped onto the
// same template while keeping their own function tools callable.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const native = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../server/opencode-native-prompt.json'), 'utf8'));
  assert.equal(native.tools.length, 12, 'official tool set is complete');
  assert(native.agent.length > 10000, 'official agent prompt is complete');
  assert(!/AlanBacker|C:\\Users/.test(native.agent), 'agent prompt carries no local paths');

  const { applyChatTemplate } = await import(pathToFileURL(path.resolve(__dirname, '../../open-sse/utils/opencodeChatTemplate.js')).href);

  const plain = { messages: [{ role: 'system', content: '你是 AstrBot 的助手。' }, { role: 'user', content: '你好' }] };
  assert.equal(applyChatTemplate(plain), true, 'generic client is rewritten');
  assert.equal(plain.tools.length, 12, 'official tools are injected');
  assert.equal(plain.tool_choice, 'none', 'no client tools -> tools disabled');
  assert(plain.messages[0].content.startsWith(native.agent.slice(0, 120)), 'official system becomes the prefix');
  assert(plain.messages[0].content.includes('你是 AstrBot 的助手。'), 'client system is preserved');
  assert.equal(plain.messages.length, 2, 'no duplicate system message');

  const weather = { type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: {} } } };
  const tooled = { messages: [{ role: 'user', content: '巴黎天气' }], tools: [weather] };
  assert.equal(applyChatTemplate(tooled), true, 'tool client is rewritten');
  assert.equal(tooled.tools.length, 13, 'client tool is merged with the official set');
  assert(tooled.tools.some((tool) => tool.function.name === 'get_weather'), 'client tool stays callable');
  assert.equal(tooled.tool_choice, undefined, 'auto tool choice is left to the model');
  assert.equal(tooled.messages[0].role, 'system', 'system message is prepended when missing');

  const forced = { messages: [{ role: 'user', content: 'x' }], tools: [weather], tool_choice: { type: 'function', function: { name: 'get_weather' } } };
  applyChatTemplate(forced);
  assert.equal(forced.tool_choice.function.name, 'get_weather', 'a forced client tool is preserved');

  const explicitNone = { messages: [{ role: 'user', content: 'x' }], tools: [weather], tool_choice: 'none' };
  applyChatTemplate(explicitNone);
  assert.equal(explicitNone.tool_choice, 'none', 'an explicit no-tools choice is preserved');

  const official = { messages: [{ role: 'system', content: native.agent }, { role: 'user', content: 'hi' }], tools: structuredClone(native.tools), tool_choice: 'auto' };
  const before = JSON.stringify(official);
  assert.equal(applyChatTemplate(official), false, 'official OpenCode request is untouched');
  assert.equal(JSON.stringify(official), before, 'official request is not mutated');

  const probe = { messages: [{ role: 'system', content: native.title }, { role: 'user', content: 'hi' }] };
  assert.equal(applyChatTemplate(probe), false, 'title probe keeps the tool-free title lane');
  assert.equal(probe.tools, undefined, 'title probe gains no tools');

  const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../server/opencode-anonymous.json'), 'utf8'));
  assert.equal(config.maxCooldownSeconds, 120, '429 cooldowns are short-lived, not until midnight UTC');

  const executor = fs.readFileSync(path.resolve(__dirname, '../../open-sse/executors/opencode.js'), 'utf8');
  assert(executor.includes('applyChatTemplate(body)'), 'chat lane applies the template mapper');

  console.log('PASS: official template rewrite, tool merge, untouched OpenCode clients, short cooldowns.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
