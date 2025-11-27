import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import { KahuaContextManager } from '../../extension';

suite('Context Detection Tests', () => {
  const testDataPath = path.join(__dirname, '..', '..', '..', 'src', 'test', 'fixtures');
  
  test('Should detect Kahua extension context from valid XML', async () => {
    // Create test XML content with Kahua extension structure
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

    const contextManager = new KahuaContextManager();
    const hasContext = contextManager.hasKahuaContext(doc);
    
    assert.strictEqual(hasContext, true, 'Should detect Kahua extension context');
    
    // Clean up
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  test('Should not detect context from non-Kahua XML', async () => {
    const regularXmlContent = `<?xml version="1.0" encoding="utf-8"?>
<root>
  <data>Some regular XML content</data>
</root>`;

    const doc = await vscode.workspace.openTextDocument({
      content: regularXmlContent,
      language: 'xml'
    });

    const contextManager = new KahuaContextManager();
    const hasContext = contextManager.hasKahuaContext(doc);
    
    assert.strictEqual(hasContext, false, 'Should not detect context from regular XML');
    
    // Clean up
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  test('Should detect datastore context', async () => {
    const datastoreXmlContent = `<?xml version="1.0" encoding="utf-8"?>
<DataStore xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Tables>
    <Table EntityDefName="TestApp.TestEntity">
      <Columns>
        <Column FieldDefName="TestField" />
      </Columns>
    </Table>
  </Tables>
</DataStore>`;

    const doc = await vscode.workspace.openTextDocument({
      content: datastoreXmlContent,
      language: 'xml'
    });

    const contextManager = new KahuaContextManager();
    const hasContext = contextManager.hasKahuaContext(doc);
    
    assert.strictEqual(hasContext, true, 'Should detect Kahua datastore context');
    
    // Clean up
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  test('Should handle malformed XML gracefully', async () => {
    const malformedXmlContent = `<?xml version="1.0" encoding="utf-8"?>
<App xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" 
     Extends="kahua_BaseApp" 
     Name="TestApp">
  <EntityDefs>
    <!-- Missing closing tags -->
  <FieldDefs>`;

    const doc = await vscode.workspace.openTextDocument({
      content: malformedXmlContent,
      language: 'xml'
    });

    const contextManager = new KahuaContextManager();
    
    // Should not throw an error and should return false for malformed XML
    assert.doesNotThrow(() => {
      const hasContext = contextManager.hasKahuaContext(doc);
      assert.strictEqual(hasContext, false, 'Should handle malformed XML gracefully');
    });
    
    // Clean up
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });
});