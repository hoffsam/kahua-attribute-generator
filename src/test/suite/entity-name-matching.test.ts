import * as assert from 'assert';
import { extractTokensFromTemplateComments, applyMultiTokenTemplate, applyInjectionPathTemplate } from '../../extension';
import * as vscode from 'vscode';

suite('Entity Name Matching Tests', () => {
  test('should preserve entity name case from template comments', () => {
    // Create a mock document with template content
    const templateContent = `// Kahua Template for attributes
// Source XML: example_xml/kahua_aec_rfi_extension.xml
// Entity Context: RFI
// Header tokens: appname:kahua_AEC_RFI, entity:RFI

<Attribute Name="TestField" Type="Text" VisualType="TextBox"/>`;

    const mockDocument = {
      getText: () => templateContent,
      fileName: 'test-template.txt'
    } as vscode.TextDocument;

    const extractedTokens = extractTokensFromTemplateComments(mockDocument);
    
    // The entity should be extracted exactly as "RFI", not "Rfi"
    assert.strictEqual(extractedTokens.get('entity'), 'RFI');
    assert.strictEqual(extractedTokens.get('appname'), 'kahua_AEC_RFI');
  });

  test('should build correct EntityDefName with preserved case', () => {
    const template = "Table[@EntityDefName='{appname}.{entity}']";
    const tokenValues = new Map([
      ['appname', 'kahua_AEC_RFI'],
      ['entity', 'RFI']
    ]);

    const result = applyMultiTokenTemplate(template, 'entity', 'RFI', tokenValues);
    
    // Should result in kahua_AEC_RFI.RFI, not kahua_AEC_RFI.Rfi
    assert.strictEqual(result, "Table[@EntityDefName='kahua_AEC_RFI.RFI']");
  });

  test('should apply injection path template with correct case', () => {
    // Test the actual injection path template used for EntityDef attributes
    const xpath = "App/EntityDefs/EntityDef/Attributes";
    const tokenValues = new Map([
      ['entity', 'RFI'] // Note: uppercase as extracted from template
    ]);
    const tokenDefinitions = [{
      id: 'appname',
      name: 'App Name Header',
      type: 'header' as const,
      tokens: 'appname,entity:Field',
      tokenReadPaths: {
        entity: {
          type: 'selection' as const,
          path: 'EntityDefs/EntityDef',
          attribute: 'Name',
          affectsInjection: true,
          injectionPathTemplate: "App/EntityDefs/EntityDef[@Name='{value}']/Attributes"
        }
      }
    }];

    const result = applyInjectionPathTemplate(xpath, tokenValues, tokenDefinitions);
    
    // Should preserve the case from the extracted token value
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.result, "App/EntityDefs/EntityDef[@Name='RFI']/Attributes");
  });

  test('should extract entity with special characters preserved', () => {
    const templateContent = `// Entity Context: RFIWorkflowItem
// Header tokens: appname:MyApp, entity:RFIWorkflowItem`;

    const mockDocument = {
      getText: () => templateContent,
      fileName: 'test-template.txt'
    } as vscode.TextDocument;

    const extractedTokens = extractTokensFromTemplateComments(mockDocument);
    assert.strictEqual(extractedTokens.get('entity'), 'RFIWorkflowItem');
  });

  test('should handle mixed case app names', () => {
    const templateContent = `// Entity Context: MyEntity
// Header tokens: appname:MyApp_Test, entity:MyEntity`;

    const mockDocument = {
      getText: () => templateContent,
      fileName: 'test-template.txt'
    } as vscode.TextDocument;

    const extractedTokens = extractTokensFromTemplateComments(mockDocument);
    assert.strictEqual(extractedTokens.get('entity'), 'MyEntity');
    assert.strictEqual(extractedTokens.get('appname'), 'MyApp_Test');
  });

  test('should demonstrate the case sensitivity fix during injection', () => {
    // This test demonstrates that entity "RFI" from template comments
    // should remain "RFI" throughout the entire injection flow
    const templateContent = `// Entity Context: RFI
// Header tokens: appname:kahua_AEC_RFI, entity:RFI`;
    
    const mockDocument = {
      getText: () => templateContent,
      fileName: 'test-template.txt'
    } as vscode.TextDocument;

    const extractedTokens = extractTokensFromTemplateComments(mockDocument);
    
    // Step 1: Extract tokens from template (should be "RFI")
    const entityValue = extractedTokens.get('entity');
    assert.strictEqual(entityValue, 'RFI', 'Entity should be extracted as "RFI"');

    // Step 2: Apply injection path template (should still be "RFI")
    const tokenDefinitions = [{
      id: 'appname',
      name: 'App Name Header', 
      type: 'header' as const,
      tokens: 'appname,entity:Field',
      tokenReadPaths: {
        entity: {
          type: 'selection' as const,
          path: 'EntityDefs/EntityDef',
          attribute: 'Name',
          affectsInjection: true,
          injectionPathTemplate: "App/EntityDefs/EntityDef[@Name='{value}']/Attributes"
        }
      }
    }];

    const xpath = "App/EntityDefs/EntityDef/Attributes";
    const result = applyInjectionPathTemplate(xpath, extractedTokens, tokenDefinitions);
    
    // Should produce correct XPath with "RFI", not "Rfi"
    assert.strictEqual(result.result, "App/EntityDefs/EntityDef[@Name='RFI']/Attributes",
      'XPath should contain "RFI" not "Rfi"');
  });
});