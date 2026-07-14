const { test } = require('node:test');
const assert = require('node:assert');

const {
  remoteControlArgs,
  remoteControlToggleInput,
  parseRemoteControlSignal,
} = require('../remote-control');

// --- remoteControlArgs ---

test('remoteControlArgs with no name is the bare flag', () => {
  assert.strictEqual(remoteControlArgs(), '--remote-control');
  assert.strictEqual(remoteControlArgs(''), '--remote-control');
  assert.strictEqual(remoteControlArgs('   '), '--remote-control');
});

test('remoteControlArgs with a name double-quotes it', () => {
  assert.strictEqual(remoteControlArgs('My Project'), '--remote-control "My Project"');
});

test('remoteControlArgs escapes embedded double-quotes and backslashes', () => {
  assert.strictEqual(
    remoteControlArgs('a"b\\c'),
    '--remote-control "a\\"b\\\\c"'
  );
});

// --- remoteControlToggleInput ---

test('remoteControlToggleInput sends the /remote-control command then a carriage return', () => {
  assert.strictEqual(remoteControlToggleInput(), '/remote-control\r');
});

// --- parseRemoteControlSignal ---

test('parseRemoteControlSignal captures a claude.ai session URL from output', () => {
  const chunk = 'Remote Control enabled\nOpen: https://claude.ai/code/abc123DEF?x=1 on your phone\n';
  assert.deepStrictEqual(
    parseRemoteControlSignal(chunk),
    { url: 'https://claude.ai/code/abc123DEF?x=1' }
  );
});

test('parseRemoteControlSignal strips surrounding ANSI/whitespace and trailing punctuation', () => {
  const chunk = '\x1b[2m  https://claude.ai/code/xyz789.  \x1b[0m';
  assert.deepStrictEqual(
    parseRemoteControlSignal(chunk),
    { url: 'https://claude.ai/code/xyz789' }
  );
});

test('parseRemoteControlSignal returns {} when no URL is present', () => {
  assert.deepStrictEqual(parseRemoteControlSignal('just some normal output'), {});
  assert.deepStrictEqual(parseRemoteControlSignal(''), {});
  assert.deepStrictEqual(parseRemoteControlSignal(null), {});
});

test('parseRemoteControlSignal ignores non-claude URLs', () => {
  assert.deepStrictEqual(
    parseRemoteControlSignal('see https://example.com/code/abc'),
    {}
  );
});
