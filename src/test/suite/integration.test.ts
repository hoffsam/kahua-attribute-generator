import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as sinon from 'sinon';

suite('Kahua Attribute Generator Integration Tests', () => {
	const testWorkspace = vscode.workspace.workspaceFolders![0].uri.fsPath;
	const testXmlPath = path.join(testWorkspace, 'test.xml');

	suiteSetup(() => {
		// Create a dummy XML file for testing
		const xmlContent = `<App Name="TestApp">
	<EntityDefs>
		<EntityDef Name="MyEntity" />
	</EntityDefs>
</App>`;
		fs.writeFileSync(testXmlPath, xmlContent);
	});

	suiteTeardown(() => {
		// Clean up the dummy file
		fs.unlinkSync(testXmlPath);
	});

	test('should generate a template from a source XML', async () => {
		// Open the test XML file
		const document = await vscode.workspace.openTextDocument(testXmlPath);
		await vscode.window.showTextDocument(document);

		// Mock the selectFragments quick pick to return a specific fragment
		const quickPickStub = sinon.stub(vscode.window, 'showQuickPick');
		quickPickStub.resolves({ label: 'Attributes', fragments: ['attributes'] } as any);

		// Execute the command
		await vscode.commands.executeCommand('kahua.showTemplateForGeneration');

		// Find the new template document
		const templateDoc = vscode.workspace.textDocuments.find(doc => doc.fileName.includes('Kahua Template for attributes'));
		assert.ok(templateDoc, 'Template document should have been opened');

		const templateText = templateDoc!.getText();
		assert.ok(templateText.includes('// Kahua Template for attributes'), 'Template header should be correct');
		assert.ok(templateText.includes('// Source XML:'), 'Template should reference the source XML file');

		quickPickStub.restore();
	}).timeout(10000);

	test('should perform full end-to-end template generation', async () => {
		// 1. Open the test XML file
		const document = await vscode.workspace.openTextDocument(testXmlPath);
		await vscode.window.showTextDocument(document);

		// 2. Stub the quick pick for fragment selection
		const fragmentQuickPick = sinon.stub(vscode.window, 'showQuickPick');
		fragmentQuickPick.resolves({ label: 'Attributes', fragments: ['attributes'] } as any);

		// 3. Execute the command to generate the template
		await vscode.commands.executeCommand('kahua.showTemplateForGeneration');
		fragmentQuickPick.restore();

		// 4. Find the newly created template document
		const templateDoc = vscode.workspace.textDocuments.find(doc => doc.getText().includes('// Kahua Template for attributes'));
		assert.ok(templateDoc, 'Template document was not created');

		// 5. Modify the template content
		const editor = await vscode.window.showTextDocument(templateDoc!);
		await editor.edit(editBuilder => {
			// Replace the entire content with new token data
			const newContent = `// Kahua Template for attributes
// Source XML URI: ${document.uri.toString()}
MyEntity
MyAttribute,TextBox,My Label`;
			const fullRange = new vscode.Range(
				templateDoc!.positionAt(0),
				templateDoc!.positionAt(templateDoc!.getText().length)
			);
			editBuilder.replace(fullRange, newContent);
		});
		await templateDoc!.save();

		// 6. Execute the command to generate the final XML
		await vscode.commands.executeCommand('kahua.generateIntoNewEditor');

		// 7. Find the generated XML document
		const generatedXmlDoc = vscode.workspace.textDocuments.find(doc => doc.languageId === 'xml' && doc.getText().includes('<!-- Group 1 Token Configuration and Values Table -->'));
		assert.ok(generatedXmlDoc, 'Final XML document was not generated');

		// 8. Verify the content of the generated XML
		const xmlContent = generatedXmlDoc!.getText();
		assert.ok(xmlContent.includes('<Attribute Name="MyAttribute"'), 'Generated XML does not contain the correct attribute');
		assert.ok(xmlContent.includes('<Label Key="MyEntity_MyAttributeLabel">My Label</Label>'), 'Generated XML does not contain the correct label');

	}).timeout(20000);
});
