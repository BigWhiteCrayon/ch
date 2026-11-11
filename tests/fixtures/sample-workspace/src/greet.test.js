const assert = require('node:assert');
const test = require('node:test');
const { greet } = require('./greet');

test('greets by name', () => {
  assert.strictEqual(greet('Ada'), 'Hello, Ada!');
});
