import * as assert from 'assert';

suite('Simple Unit Tests', () => {
	test('should run basic assertions', () => {
		assert.strictEqual(1 + 1, 2);
		assert.ok(true);
		assert.notStrictEqual('hello', 'world');
	});

	test('should handle arrays', () => {
		const arr = [1, 2, 3];
		assert.strictEqual(arr.length, 3);
		assert.ok(arr.includes(2));
	});

	test('should handle objects', () => {
		const obj = { name: 'test', value: 42 };
		assert.strictEqual(obj.name, 'test');
		assert.strictEqual(obj.value, 42);
	});
});