import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Extension should be present', () => {
		assert.ok(vscode.extensions.getExtension('Sammy.kahua-attribute-generator'));
	});

	test('Extension should activate', async () => {
		const extension = vscode.extensions.getExtension('Sammy.kahua-attribute-generator');
		if (extension) {
			await extension.activate();
			assert.ok(extension.isActive);
		}
	});

	test('Configuration should have expected properties', () => {
		const config = vscode.workspace.getConfiguration('kahua');
		
		// Test that configuration properties exist
		assert.ok(config.has('showInContextMenu'));
		assert.ok(config.has('suppressInvalidConditionWarnings'));
		assert.ok(config.has('showSnippetsInMenu'));
		assert.ok(config.has('showTemplatesInMenu'));
		assert.ok(config.has('defaultSnippetRows'));
		assert.ok(config.has('defaultSnippetTableRows'));
		assert.ok(config.has('tokenNameDefinitions'));
		assert.ok(config.has('fragmentDefinitions'));
	});

	test('Default configuration should have expected values', () => {
		const config = vscode.workspace.getConfiguration('kahua');
		
		// Test default values
		assert.strictEqual(config.get('showInContextMenu'), true);
		assert.strictEqual(config.get('suppressInvalidConditionWarnings'), false);
		assert.strictEqual(config.get('showSnippetsInMenu'), true);
		assert.strictEqual(config.get('showTemplatesInMenu'), true);
		assert.strictEqual(config.get('defaultSnippetRows'), 3);
		assert.strictEqual(config.get('defaultSnippetTableRows'), 0);
		
		// Test that arrays have expected structure
		const tokenDefs = config.get('tokenNameDefinitions') as any[];
		assert.ok(Array.isArray(tokenDefs));
		assert.ok(tokenDefs.length > 0);
		
		const fragmentDefs = config.get('fragmentDefinitions') as any[];
		assert.ok(Array.isArray(fragmentDefs));
		assert.ok(fragmentDefs.length > 0);
		
	});
});
