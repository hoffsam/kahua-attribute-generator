import * as assert from 'assert';
import * as vscode from 'vscode';

// Import the function we want to test
import { extractTokensFromTemplateComments } from '../../extension';

suite('Template Parsing Tests', () => {
  
  suite('extractTokensFromTemplateComments', () => {
    
    test('should extract entity context from template comments', async () => {
      const templateContent = `// Kahua Template for attributes
// Source XML: example_xml/kahua_aec_rfi_extension.xml
// Token Template for attributes:
// ----------------------------------------------------------------
// Entity Context: RFI
// All template rows will target this entity. Update this header if you change entities.
// Smart injection will automatically use this entity for Attributes, Labels, and DataTags.
// ----------------------------------------------------------------
// Header tokens: appname, entity:Field
// Table tokens: name, type:Text, visualtype:TextBox, label, descriptionlabel, linkedEntityDef

<Attribute Name="{name}" Type="{type}" VisualType="{visualtype}" Label="{label}" DescriptionLabel="{descriptionlabel}" LinkedEntityDef="{linkedEntityDef}" />`;

      const document = await vscode.workspace.openTextDocument({
        content: templateContent,
        language: 'plaintext'
      });
      
      const extractedTokens = extractTokensFromTemplateComments(document);
      
      assert.strictEqual(extractedTokens.get('entity'), 'RFI');
    });
    
    test('should extract header tokens from template comments', async () => {
      const templateContent = `// Kahua Template for attributes
// Source XML: example_xml/kahua_aec_rfi_extension.xml
// Token Template for attributes:
// ----------------------------------------------------------------
// Entity Context: RFI
// All template rows will target this entity. Update this header if you change entities.
// Smart injection will automatically use this entity for Attributes, Labels, and DataTags.
// ----------------------------------------------------------------
// Header tokens: appname:MyApp, entity:RFI, baseapp:BaseApplication
// Table tokens: name, type:Text, visualtype:TextBox, label, descriptionlabel, linkedEntityDef

<Attribute Name="{name}" Type="{type}" VisualType="{visualtype}" Label="{label}" DescriptionLabel="{descriptionlabel}" LinkedEntityDef="{linkedEntityDef}" />`;

      const document = await vscode.workspace.openTextDocument({
        content: templateContent,
        language: 'plaintext'
      });
      
      const extractedTokens = extractTokensFromTemplateComments(document);
      
      assert.strictEqual(extractedTokens.get('entity'), 'RFI');
      assert.strictEqual(extractedTokens.get('appname'), 'MyApp');
      assert.strictEqual(extractedTokens.get('baseapp'), 'BaseApplication');
    });
    
    test('should handle template with no entity context', async () => {
      const templateContent = `// Kahua Template for labels
// Source XML: example_xml/kahua_aec_rfi_extension.xml
// Token Template for labels:
// Header tokens: appname:MyApp
// Table tokens: key, label

<Label Key="{key}" Value="{label}" />`;

      const document = await vscode.workspace.openTextDocument({
        content: templateContent,
        language: 'plaintext'
      });
      
      const extractedTokens = extractTokensFromTemplateComments(document);
      
      assert.strictEqual(extractedTokens.get('entity'), undefined);
      assert.strictEqual(extractedTokens.get('appname'), 'MyApp');
    });
    
    test('should ignore generic entity placeholder', async () => {
      const templateContent = `// Kahua Template for attributes
// Entity Context: <Select entity>
// Header tokens: appname:MyApp`;

      const document = await vscode.workspace.openTextDocument({
        content: templateContent,
        language: 'plaintext'
      });
      
      const extractedTokens = extractTokensFromTemplateComments(document);
      
      assert.strictEqual(extractedTokens.get('entity'), undefined);
      assert.strictEqual(extractedTokens.get('appname'), 'MyApp');
    });
    
    test('should handle mixed comment formats', async () => {
      const templateContent = `// Kahua Template for attributes
// Entity Context: TestEntity
//Header tokens:appname:TestApp,entity:TestEntity
// Some other comment
// Header tokens: category:TestCategory
`;

      const document = await vscode.workspace.openTextDocument({
        content: templateContent,
        language: 'plaintext'
      });
      
      const extractedTokens = extractTokensFromTemplateComments(document);
      
      assert.strictEqual(extractedTokens.get('entity'), 'TestEntity');
      assert.strictEqual(extractedTokens.get('appname'), 'TestApp');
      assert.strictEqual(extractedTokens.get('category'), 'TestCategory');
    });
  });
});