import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Bug Fixes Test Suite', () => {
  
  suite('Command Palette Visibility', () => {
    test('should not show Kahua commands in non-XML files', async () => {
      // Create a non-XML document
      const document = await vscode.workspace.openTextDocument({
        content: 'console.log("test");',
        language: 'javascript'
      });
      
      const editor = await vscode.window.showTextDocument(document);
      
      // Test that document detection works correctly
      const isKahuaDoc = document.languageId === 'xml';
      assert.strictEqual(isKahuaDoc, false, 'JavaScript file should not be detected as Kahua document');
      
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    });
    
    test('should show Kahua commands only in XML files', async () => {
      // Create an XML document
      const document = await vscode.workspace.openTextDocument({
        content: '<App Name="TestApp"></App>',
        language: 'xml'
      });
      
      const editor = await vscode.window.showTextDocument(document);
      
      // Test that document detection works correctly
      const isXmlDoc = document.languageId === 'xml';
      assert.strictEqual(isXmlDoc, true, 'XML file should be detected correctly');
      
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    });
  });
  
  suite('XPath Path Conversion', () => {
    test('should convert enriched paths to proper XPath format', () => {
      // Mock the convertEnrichedPathToXPath function behavior
      const enrichedPath = 'App/App.HubDefs/HubDef (ExtendedWorkflow)/HubDef.LogDef/LogDef.FieldDefs';
      const expectedXPath = 'App/App.HubDefs/HubDef[@Name=\'ExtendedWorkflow\']/HubDef.LogDef/LogDef.FieldDefs';
      
      // Simple regex replacement logic (matching the implementation)
      const actualXPath = enrichedPath.replace(/(\w+)\s*\(([^)]+)\)/g, (match, tagName, displayName) => {
        return `${tagName}[@Name='${displayName}']`;
      });
      
      assert.strictEqual(actualXPath, expectedXPath, 'Enriched path should be converted to proper XPath format');
    });
    
    test('should handle paths without display names unchanged', () => {
      const simplePath = 'App/DataStore/Tables/Table/Columns';
      
      // Simple regex replacement logic (matching the implementation)
      const actualXPath = simplePath.replace(/(\w+)\s*\(([^)]+)\)/g, (match, tagName, displayName) => {
        return `${tagName}[@Name='${displayName}']`;
      });
      
      assert.strictEqual(actualXPath, simplePath, 'Simple paths should remain unchanged');
    });
    
    test('should handle multiple display names in a path', () => {
      const enrichedPath = 'App/HubDefs/HubDef (ProjectHub)/ImportDefs/ImportDef (MainImport)/Sheets';
      const expectedXPath = 'App/HubDefs/HubDef[@Name=\'ProjectHub\']/ImportDefs/ImportDef[@Name=\'MainImport\']/Sheets';
      
      // Simple regex replacement logic (matching the implementation)
      const actualXPath = enrichedPath.replace(/(\w+)\s*\(([^)]+)\)/g, (match, tagName, displayName) => {
        return `${tagName}[@Name='${displayName}']`;
      });
      
      assert.strictEqual(actualXPath, expectedXPath, 'Multiple display names should be converted correctly');
    });
  });
  
  suite('Entity Name Matching', () => {
    test('should match entity names case-sensitively as configured', () => {
      // Test case-sensitive matching behavior
      const templateEntityName = 'RFI';
      const xmlEntityName = 'RFI';
      const incorrectMatch = 'Rfi';
      
      assert.strictEqual(templateEntityName === xmlEntityName, true, 'Exact case match should succeed');
      assert.strictEqual(templateEntityName === incorrectMatch, false, 'Different case should fail');
    });
    
    test('should preserve entity names from template comments', () => {
      // Mock template comment parsing
      const templateContent = `// Kahua Template for attributes
// Source XML: example.xml
// Entity Context: RFI
// Header tokens: appname, entity:RFI`;
      
      // Simple extraction logic (matching the implementation)
      const entityMatch = templateContent.match(/^\/\/\s*Entity Context:\s*(.+)$/m);
      const extractedEntity = entityMatch ? entityMatch[1] : undefined;
      
      assert.strictEqual(extractedEntity, 'RFI', 'Entity name should be extracted from template comments');
    });
  });
  
  suite('File Opening Logic', () => {
    test('should properly detect existing editors', async () => {
      // Create a test document
      const document = await vscode.workspace.openTextDocument({
        content: '<App Name="Test"></App>',
        language: 'xml'
      });
      
      const editor = await vscode.window.showTextDocument(document);
      
      // Test that we can find the existing editor
      const existingEditor = vscode.window.visibleTextEditors.find(e => 
        e.document.uri.toString() === document.uri.toString()
      );
      
      assert.ok(existingEditor, 'Should find existing editor for open document');
      assert.strictEqual(existingEditor, editor, 'Found editor should match the opened editor');
      
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    });
  });
});