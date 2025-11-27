import * as assert from 'assert';
import { suite, test } from 'mocha';

suite('Entity Name Matching Tests', () => {
  suite('Template Entity Context Parsing', () => {
    test('should extract correct entity name from template header', () => {
      const templateContent = `// Kahua Template for attributes
// Source XML: example_xml/kahua_aec_rfi_extension.xml
// Source XML URI: file:///g%3A/OneDrive/Documents/vscode%20projects/xsd_analyzer_updated/example_files/example_xml/kahua_aec_rfi_extension.xml
// Token Template for attributes:
// ----------------------------------------------------------------
// Entity Context: RFI
// All template rows will target this entity. Update this header if you change entities.
// Smart injection will automatically use this entity for Attributes, Labels, and DataTags.
// ----------------------------------------------------------------`;

      // Extract entity context from template
      const entityMatch = templateContent.match(/^\/\/ Entity Context: (.+)$/m);
      const extractedEntity = entityMatch ? entityMatch[1].trim() : null;
      
      assert.strictEqual(extractedEntity, 'RFI', 'Should extract RFI from Entity Context header');
    });

    test('should handle different entity name formats in template', () => {
      const testCases = [
        { template: '// Entity Context: RFI', expected: 'RFI' },
        { template: '// Entity Context: ResponderItem', expected: 'ResponderItem' },
        { template: '// Entity Context: SomeOtherEntity', expected: 'SomeOtherEntity' },
        { template: '// Entity Context:   Padded   ', expected: 'Padded' }
      ];

      testCases.forEach(({ template, expected }) => {
        const entityMatch = template.match(/^\/\/ Entity Context: (.+)$/m);
        const extractedEntity = entityMatch ? entityMatch[1].trim() : null;
        assert.strictEqual(extractedEntity, expected, `Should extract ${expected} from template`);
      });
    });
  });

  suite('XPath Entity Name Substitution', () => {
    test('should create correct XPath with extracted entity name', () => {
      const basePath = "App/EntityDefs/EntityDef[@Name='{entity}']/Attributes";
      const entityName = "RFI";
      const expectedPath = "App/EntityDefs/EntityDef[@Name='RFI']/Attributes";
      
      const actualPath = basePath.replace('{entity}', entityName);
      
      assert.strictEqual(actualPath, expectedPath, 'Should substitute entity name correctly in XPath');
    });

    test('should preserve case sensitivity in XPath substitution', () => {
      const testCases = [
        { entity: 'RFI', expected: "App/EntityDefs/EntityDef[@Name='RFI']/Attributes" },
        { entity: 'ResponderItem', expected: "App/EntityDefs/EntityDef[@Name='ResponderItem']/Attributes" },
        { entity: 'rfi', expected: "App/EntityDefs/EntityDef[@Name='rfi']/Attributes" }
      ];

      const basePath = "App/EntityDefs/EntityDef[@Name='{entity}']/Attributes";
      
      testCases.forEach(({ entity, expected }) => {
        const actualPath = basePath.replace('{entity}', entity);
        assert.strictEqual(actualPath, expected, `Should preserve case for entity: ${entity}`);
      });
    });
  });

  suite('Integration Test - Template to XPath Flow', () => {
    test('should correctly flow from template entity context to XPath search', () => {
      // Simulate the full flow
      const templateContent = `// Entity Context: RFI`;
      const injectionPath = "App/EntityDefs/EntityDef[@Name='{entity}']/Attributes";
      
      // Step 1: Extract entity from template
      const entityMatch = templateContent.match(/^\/\/ Entity Context: (.+)$/m);
      const extractedEntity = entityMatch ? entityMatch[1].trim() : null;
      
      // Step 2: Substitute in XPath
      const finalPath = injectionPath.replace('{entity}', extractedEntity || '');
      
      // Step 3: Verify the result matches what XML contains
      const expectedPath = "App/EntityDefs/EntityDef[@Name='RFI']/Attributes";
      assert.strictEqual(finalPath, expectedPath, 'Full flow should produce correct XPath');
      
      // This should match XML element: <EntityDef Name="RFI" ...>
      assert.strictEqual(extractedEntity, 'RFI', 'Entity name should match XML attribute value exactly');
    });

    test('should fail appropriately when entity names do not match', () => {
      // This represents the current bug scenario
      const templateEntity = 'RFI';  // From template header
      const xmlEntityName = 'RFI';   // From XML: <EntityDef Name="RFI" ...>
      const searchingFor = 'Rfi';    // What the code is incorrectly searching for
      
      // This should be true (correct match)
      assert.strictEqual(templateEntity, xmlEntityName, 'Template and XML should match');
      
      // This demonstrates the bug (incorrect search)
      assert.notStrictEqual(searchingFor, xmlEntityName, 'Bug: searching for wrong case');
    });
  });
});