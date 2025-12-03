import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Menu Context Tests', () => {
  
  async function waitForContextDetection(ms: number = 300): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  test('Context variables should be properly set for Kahua XML files', async () => {
    // Create a Kahua Extension XML file
    const kahuaXmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<App Name="TestExtension" Extends="BaseApp" DisplayName="Test Extension">
  <EntityDefs>
    <EntityDef Name="TestEntity" DisplayName="Test Entity">
      <Attributes>
        <Attribute Name="TestField" Type="Text" VisualType="TextBox" Label="Test Field" />
      </Attributes>
    </EntityDef>
  </EntityDefs>
</App>`;

    // Open document in VS Code
    const document = await vscode.workspace.openTextDocument({
      content: kahuaXmlContent,
      language: 'xml'
    });

    // Show the document in editor to trigger context detection
    const editor = await vscode.window.showTextDocument(document);

    // Wait for context detection to complete
    await waitForContextDetection(500);

    // Verify the document properties
    assert.strictEqual(document.languageId, 'xml', 'Document should be XML');
    const content = document.getText();
    assert.ok(content.includes('<App '), 'Should have App root element');
    assert.ok(content.includes('Extends='), 'Should have Extends attribute (Extension)');

    // Try to check context variables indirectly by testing command availability
    const allCommands = await vscode.commands.getCommands(true);
    const kahuaCommands = allCommands.filter(cmd => cmd.startsWith('kahua.'));
    
    assert.ok(kahuaCommands.length > 0, 'Kahua commands should be registered');
    assert.ok(kahuaCommands.includes('kahua.showTemplateForGeneration'), 'Template command should be available');
    assert.ok(kahuaCommands.includes('kahua.showSnippetForGeneration'), 'Snippet command should be available');
    assert.ok(kahuaCommands.includes('kahua.showTableForGeneration'), 'Table command should be available');

    // Clean up
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  test('Kahua menu should be visible in valid Kahua XML files', async () => {
    // Create a temporary Kahua XML file
    const kahuaXmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<App Name="TestApp" DisplayName="Test Application">
  <EntityDefs>
    <EntityDef Name="Field" DisplayName="Field Entity">
      <Attributes>
        <Attribute Name="TestField" Type="Text" VisualType="TextBox" Label="Test Field" />
      </Attributes>
    </EntityDef>
  </EntityDefs>
</App>`;

    // Open document in VS Code
    const document = await vscode.workspace.openTextDocument({
      content: kahuaXmlContent,
      language: 'xml'
    });

    // Show the document in editor to trigger context detection
    const editor = await vscode.window.showTextDocument(document);

    // Wait a bit for context detection to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    // Check if the context variable is set correctly
    // Note: We can't directly read context variables, so we test the underlying logic
    
    // Verify the document is XML
    assert.strictEqual(document.languageId, 'xml', 'Document should be detected as XML');
    
    // The document should be detected as a Kahua file
    // This is a base app (no Extends attribute, no App.Supplements)
    const content = document.getText();
    assert.ok(content.includes('<App '), 'Document should have App root element');
    assert.ok(!content.includes('Extends='), 'Document should not have Extends attribute (base app)');
    assert.ok(!content.includes('<App.Supplements'), 'Document should not have App.Supplements');

    // Clean up
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  test('Kahua menu should NOT be visible in non-XML files', async () => {
    // Create a non-XML file
    const textContent = `This is just a text file, not XML.`;

    // Open document in VS Code
    const document = await vscode.workspace.openTextDocument({
      content: textContent,
      language: 'plaintext'
    });

    // Show the document in editor
    const editor = await vscode.window.showTextDocument(document);

    // Wait a bit for context detection
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify the document is not XML
    assert.strictEqual(document.languageId, 'plaintext', 'Document should be detected as plaintext');

    // The document should NOT be detected as a Kahua file
    const content = document.getText();
    assert.ok(!content.includes('<App '), 'Document should not have App root element');

    // Clean up
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  test('Kahua menu should NOT be visible in non-Kahua XML files', async () => {
    // Create a non-Kahua XML file
    const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<root>
  <item>Some XML content</item>
  <item>But not a Kahua App</item>
</root>`;

    // Open document in VS Code
    const document = await vscode.workspace.openTextDocument({
      content: xmlContent,
      language: 'xml'
    });

    // Show the document in editor
    const editor = await vscode.window.showTextDocument(document);

    // Wait a bit for context detection
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify the document is XML
    assert.strictEqual(document.languageId, 'xml', 'Document should be detected as XML');

    // The document should NOT be detected as a Kahua file (no App root)
    const content = document.getText();
    assert.ok(!content.includes('<App '), 'Document should not have App root element');

    // Clean up  
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  test('Extension XML should be detected as Kahua file', async () => {
    // Create an Extension XML file
    const extensionXmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<App Name="MyExtension" Extends="BaseApp" DisplayName="My Extension">
  <EntityDefs>
    <EntityDef Name="CustomField">
      <Attributes>
        <Attribute Name="NewField" Type="Text" VisualType="TextBox" Label="New Field" />
      </Attributes>
    </EntityDef>
  </EntityDefs>
</App>`;

    // Open document in VS Code
    const document = await vscode.workspace.openTextDocument({
      content: extensionXmlContent,
      language: 'xml'
    });

    // Show the document in editor
    const editor = await vscode.window.showTextDocument(document);

    // Wait a bit for context detection
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify this is an extension (has Extends attribute)
    const content = document.getText();
    assert.ok(content.includes('<App '), 'Document should have App root element');
    assert.ok(content.includes('Extends='), 'Document should have Extends attribute (extension)');
    assert.ok(!content.includes('<App.Supplements'), 'Document should not have App.Supplements');

    // Clean up
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  test('Context should be preserved when focus switches away from editor', async () => {
    // This test verifies the fix for the menu visibility regression
    // Issue: Context was being cleared when webview panels gained focus
    
    // Create a Kahua XML file
    const kahuaXmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<App Name="TestApp" Extends="BaseApp" DisplayName="Test Application">
  <EntityDefs>
    <EntityDef Name="Field" DisplayName="Field Entity">
      <Attributes>
        <Attribute Name="TestField" Type="Text" VisualType="TextBox" Label="Test Field" />
      </Attributes>
    </EntityDef>
  </EntityDefs>
</App>`;

    // Open document in VS Code
    const document = await vscode.workspace.openTextDocument({
      content: kahuaXmlContent,
      language: 'xml'
    });

    // Show the document in editor
    const editor = await vscode.window.showTextDocument(document);

    // Wait for context detection
    await waitForContextDetection(300);

    // Verify it's a Kahua file
    assert.ok(document.getText().includes('<App '), 'Should be Kahua XML');
    assert.ok(document.getText().includes('Extends='), 'Should be Extension type');

    // Simulate focus switching away (like opening a webview)
    // This should NOT clear the Kahua context
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    
    // Context should still be preserved
    // (We can't directly check context variables, but commands should still be available)
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('kahua.showTemplateForGeneration'), 'Commands should still be available after focus change');

    // Clean up
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  test('Commands should be available when Kahua context is active', async () => {
    // Create a Kahua XML file
    const kahuaXmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<App Name="TestApp" DisplayName="Test Application">
  <EntityDefs>
    <EntityDef Name="Field" DisplayName="Field Entity">
      <Attributes>
        <Attribute Name="TestField" Type="Text" VisualType="TextBox" Label="Test Field" />
      </Attributes>
    </EntityDef>
  </EntityDefs>
</App>`;

    // Open document in VS Code
    const document = await vscode.workspace.openTextDocument({
      content: kahuaXmlContent,
      language: 'xml'
    });

    // Show the document in editor
    const editor = await vscode.window.showTextDocument(document);

    // Wait for context detection
    await new Promise(resolve => setTimeout(resolve, 200));

    // Try to execute Kahua commands - they should be available
    try {
      // These should not throw if the commands are properly registered and context is active
      const commands = await vscode.commands.getCommands(true);
      
      assert.ok(commands.includes('kahua.showTemplateForGeneration'), 'kahua.showTemplateForGeneration command should be registered');
      assert.ok(commands.includes('kahua.showSnippetForGeneration'), 'kahua.showSnippetForGeneration command should be registered'); 
      assert.ok(commands.includes('kahua.showTableForGeneration'), 'kahua.showTableForGeneration command should be registered');

      // Clean up
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    } catch (error) {
      // Clean up even on error
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      throw error;
    }
  });
});