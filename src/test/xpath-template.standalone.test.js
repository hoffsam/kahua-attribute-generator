/**
 * Standalone test for XPath template application fix
 * This can run without VS Code environment since it doesn't import the main extension
 */

const assert = require('assert');

// Standalone implementation of the fixed function for testing
function applyInjectionPathTemplate(xpath, affectingTokens, tokenDefinitions = []) {
  let modifiedXPath = xpath;
  let applied = false;

  // Check each token definition for injection path templates
  for (const tokenDef of tokenDefinitions) {
    if (tokenDef.tokenReadPaths) {
      for (const [tokenName, readPath] of Object.entries(tokenDef.tokenReadPaths)) {
        if (readPath.affectsInjection && readPath.injectionPathTemplate && affectingTokens.has(tokenName)) {
          // Extract the base path from the template (everything before the filter)
          const templateBasePath = readPath.injectionPathTemplate.split('[')[0];

          // Parse both paths to compare their structural elements, not just string matching
          const xpathParts = xpath.split('/').filter(p => p);
          const templateParts = templateBasePath.split('/').filter(p => p);
          
          // Check if this template should apply to this xpath by comparing path structure
          let shouldApplyTemplate = false;
          
          // For EntityDef-based templates, check if we're actually targeting EntityDef elements
          if (templateBasePath.includes('EntityDef')) {
            // Only apply if the xpath has EntityDef as a path element (not just in attribute filters)
            shouldApplyTemplate = xpathParts.some(part => {
              // Check if this part is "EntityDef" or "EntityDef[...]" but not "@EntityDefName"
              return part === 'EntityDef' || (part.startsWith('EntityDef[') && !part.includes('@EntityDefName'));
            });
          } else {
            // For other templates, check exact path match
            shouldApplyTemplate = xpath === templateBasePath;
          }
          
          if (shouldApplyTemplate) {
            const tokenValue = affectingTokens.get(tokenName);
            modifiedXPath = readPath.injectionPathTemplate.replace('{value}', tokenValue);
            applied = true;
            console.log(`Applied injection path template: ${xpath} -> ${modifiedXPath} (token: ${tokenName}=${tokenValue})`);
            break;
          }
        }
      }
    }
  }

  return {
    success: true,
    result: applied ? modifiedXPath : xpath
  };
}

// Test suite
describe('XPath Template Application Fix', function() {
  // Mock token definitions for testing
  const mockTokenDefinitions = [{
    id: 'appname',
    name: 'App Name Header',
    type: 'header',
    tokens: 'appname,entity:Field',
    tokenReadPaths: {
      entity: {
        type: 'selection',
        path: 'EntityDefs/EntityDef',
        attribute: 'Name',
        affectsInjection: true,
        injectionPathTemplate: 'EntityDefs/EntityDef[@Name=\'{value}\']/Attributes'
      }
    }
  }];

  const mockAffectingTokens = new Map([['entity', 'EntityA']]);

  describe('applyInjectionPathTemplate', function() {
    it('should apply template to correct EntityDef paths', function() {
      const xpath = 'EntityDefs/EntityDef/Attributes';
      const result = applyInjectionPathTemplate(xpath, mockAffectingTokens, mockTokenDefinitions);
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.result, 'EntityDefs/EntityDef[@Name=\'EntityA\']/Attributes');
    });

    it('should NOT apply template to DataStore paths with EntityDefName attribute', function() {
      const xpath = 'DataStore/Tables/Table[@EntityDefName=\'something\']/Columns';
      const result = applyInjectionPathTemplate(xpath, mockAffectingTokens, mockTokenDefinitions);
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.result, xpath); // Should remain unchanged
    });

    it('should NOT apply template to unrelated paths', function() {
      const xpath = 'Cultures/Culture[@Code=\'en\']/Labels';
      const result = applyInjectionPathTemplate(xpath, mockAffectingTokens, mockTokenDefinitions);
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.result, xpath); // Should remain unchanged
    });

    it('should apply template to EntityDef paths with existing attribute filters', function() {
      const xpath = 'EntityDefs/EntityDef[@SomeAttr=\'value\']/Attributes';
      const result = applyInjectionPathTemplate(xpath, mockAffectingTokens, mockTokenDefinitions);
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.result, 'EntityDefs/EntityDef[@Name=\'EntityA\']/Attributes');
    });

    it('should handle paths without affecting tokens', function() {
      const xpath = 'EntityDefs/EntityDef/Attributes';
      const emptyTokens = new Map();
      const result = applyInjectionPathTemplate(xpath, emptyTokens, mockTokenDefinitions);
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.result, xpath); // Should remain unchanged
    });

    it('should handle empty token definitions', function() {
      const xpath = 'EntityDefs/EntityDef/Attributes';
      const result = applyInjectionPathTemplate(xpath, mockAffectingTokens, []);
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.result, xpath); // Should remain unchanged
    });

    it('should handle complex DataStore paths without false matching', function() {
      const xpath = 'DataStore/Tables/Table[@EntityDefName=\'MyEntity\']/Columns';
      const result = applyInjectionPathTemplate(xpath, mockAffectingTokens, mockTokenDefinitions);
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.result, xpath); // Should remain unchanged
    });

    it('should properly distinguish path elements from attribute names', function() {
      // This path contains "EntityDef" in attribute name but not as path element
      const xpath = 'SomeOther/Path[@LinkedEntityDef=\'test\']/Elements';
      const result = applyInjectionPathTemplate(xpath, mockAffectingTokens, mockTokenDefinitions);
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.result, xpath); // Should remain unchanged
    });

    it('should handle EntityDef with brackets in path', function() {
      const xpath = 'EntityDefs/EntityDef[@Name=\'ExistingEntity\']/Attributes';
      const result = applyInjectionPathTemplate(xpath, mockAffectingTokens, mockTokenDefinitions);
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.result, 'EntityDefs/EntityDef[@Name=\'EntityA\']/Attributes');
    });

    it('should work with different entity values', function() {
      const differentTokens = new Map([['entity', 'DifferentEntity']]);
      const xpath = 'EntityDefs/EntityDef/Attributes';
      const result = applyInjectionPathTemplate(xpath, differentTokens, mockTokenDefinitions);
      
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.result, 'EntityDefs/EntityDef[@Name=\'DifferentEntity\']/Attributes');
    });
  });
});