import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Menu Visibility Tests', () => {
  test('Extension should be present and active', async () => {
    // Check if the extension is present
    const extension = vscode.extensions.getExtension('Sammy.kahua-attribute-generator');
    assert.ok(extension, 'Kahua extension should be present');
    
    // Activate the extension if not already active
    if (!extension.isActive) {
      await extension.activate();
    }
    assert.ok(extension.isActive, 'Extension should be active');
  });

  test('Kahua commands should be registered', async () => {
    // Get all available commands
    const availableCommands = await vscode.commands.getCommands();
    const kahuaCommands = availableCommands.filter(cmd => cmd.startsWith('kahua.'));
    
    assert.ok(kahuaCommands.length > 0, 'Should have Kahua commands registered');
    
    // Check for essential commands
    const essentialCommands = [
      'kahua.showTemplate',
      'kahua.showSnippet', 
      'kahua.showTable'
    ];
    
    for (const command of essentialCommands) {
      assert.ok(kahuaCommands.includes(command), `${command} should be registered`);
    }
    
    console.log(`Found ${kahuaCommands.length} Kahua commands`);
  });

  test('Should create Kahua XML document', async () => {

    const kahuaXmlContent = `<?xml version="1.0" encoding="utf-8"?>
<App xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" 
     xmlns:xsd="http://www.w3.org/2001/XMLSchema" 
     Extends="kahua_BaseApp" 
     Name="TestApp">
  <EntityDefs>
    <EntityDef Name="TestEntity" EntityType="Standalone">
      <FieldDefs>
        <FieldDef Name="TestField" Type="Text" />
      </FieldDefs>
    </EntityDef>
  </EntityDefs>
</App>`;

    // Create a temporary document
    const doc = await vscode.workspace.openTextDocument({
      content: kahuaXmlContent,
      language: 'xml'
    });

    assert.ok(doc, 'Should create document');
    assert.strictEqual(doc.languageId, 'xml', 'Should be XML language');
    assert.ok(doc.getText().includes('<App'), 'Should contain App element');
    assert.ok(doc.getText().includes('Extends='), 'Should contain Extends attribute');
    
    // Clean up by closing the document
    const editor = await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });
});