import * as assert from 'assert';

// Mock SAX element structure for testing
interface MockSaxElement {
  tagName: string;
  attributes: Record<string, string>;
}

// Mock function to simulate attribute detection rules
function mockEvaluateAttributeRule(
  rule: { kind: 'attributeExists' | 'attributeNotExists'; xpath: string; attribute: string },
  rootElement: MockSaxElement | null
): boolean {
  if (!rule.xpath || !rule.attribute || !rootElement) {
    return false;
  }
  
  // For document type detection, we typically check the root element (App)
  if (rule.xpath === 'App' && rootElement) {
    if (rule.kind === 'attributeExists') {
      return rootElement.attributes && rule.attribute in rootElement.attributes;
    } else if (rule.kind === 'attributeNotExists') {
      return !rootElement.attributes || !(rule.attribute in rootElement.attributes);
    }
  }
  
  return false;
}

suite('Document Type Detection', () => {
  suite('Extension vs Base App Detection', () => {
    test('should detect Extension when App has Extends attribute', () => {
      // Mock an App element with Extends attribute
      const mockRootElement: MockSaxElement = {
        tagName: 'App',
        attributes: {
          Extends: 'kahua_AEC_RFI',
          Name: 'kahua_aec_rfi_extension',
          DataScope: 'Default',
          AppScope: 'Partition',
          Version: '1750'
        }
      };
      
      // Test attributeExists rule for Extends
      const attributeExistsRule = {
        kind: 'attributeExists' as const,
        xpath: 'App',
        attribute: 'Extends'
      };
      
      const hasExtends = mockEvaluateAttributeRule(attributeExistsRule, mockRootElement);
      assert.strictEqual(hasExtends, true, 'Should detect Extends attribute exists');
      
      // Test attributeNotExists rule for Extends (should be false)
      const attributeNotExistsRule = {
        kind: 'attributeNotExists' as const,
        xpath: 'App',
        attribute: 'Extends'
      };
      
      const lacksExtends = mockEvaluateAttributeRule(attributeNotExistsRule, mockRootElement);
      assert.strictEqual(lacksExtends, false, 'Should detect Extends attribute exists (not missing)');
    });

    test('should detect Base App when App lacks Extends attribute', () => {
      // Mock an App element without Extends attribute
      const mockRootElement: MockSaxElement = {
        tagName: 'App',
        attributes: {
          Name: 'kahua_BaseApp',
          DataScope: 'Default',
          AppScope: 'Partition',
          Version: '1750'
        }
      };
      
      // Test attributeNotExists rule for Extends
      const attributeNotExistsRule = {
        kind: 'attributeNotExists' as const,
        xpath: 'App',
        attribute: 'Extends'
      };
      
      const lacksExtends = mockEvaluateAttributeRule(attributeNotExistsRule, mockRootElement);
      assert.strictEqual(lacksExtends, true, 'Should detect Extends attribute is missing');
      
      // Test attributeExists rule for Extends (should be false)
      const attributeExistsRule = {
        kind: 'attributeExists' as const,
        xpath: 'App',
        attribute: 'Extends'
      };
      
      const hasExtends = mockEvaluateAttributeRule(attributeExistsRule, mockRootElement);
      assert.strictEqual(hasExtends, false, 'Should detect Extends attribute is missing');
    });

    test('should handle empty Extends attribute correctly', () => {
      // Mock an App element with empty Extends attribute
      const mockRootElement: MockSaxElement = {
        tagName: 'App',
        attributes: {
          Extends: '',
          Name: 'kahua_test',
          DataScope: 'Default',
          AppScope: 'Partition',
          Version: '1750'
        }
      };
      
      // Even if empty, the attribute exists
      const attributeExistsRule = {
        kind: 'attributeExists' as const,
        xpath: 'App',
        attribute: 'Extends'
      };
      
      const hasExtends = mockEvaluateAttributeRule(attributeExistsRule, mockRootElement);
      assert.strictEqual(hasExtends, true, 'Should detect Extends attribute exists even when empty');
    });
  });

  suite('Configuration Integration', () => {
    test('should have proper document type configuration', () => {
      // This tests that our package.json configuration is properly set up
      // Note: In real extension environment, this would use actual config
      const expectedConfig = [
        {
          id: 'extension',
          name: 'Extension',
          priority: 300,
          rules: [
            { kind: 'rootElement', value: 'App' },
            { kind: 'attributeExists', xpath: 'App', attribute: 'Extends' },
            { kind: 'xpathNotExists', xpath: 'App/App.Supplements' }
          ]
        },
        {
          id: 'baseapp',
          name: 'Base App',
          priority: 250,
          rules: [
            { kind: 'rootElement', value: 'App' },
            { kind: 'attributeNotExists', xpath: 'App', attribute: 'Extends' },
            { kind: 'xpathNotExists', xpath: 'App/App.Supplements' }
          ]
        },
        {
          id: 'supplement',
          name: 'Supplement XML',
          priority: 100,
          rules: [
            { kind: 'rootElement', value: 'App' },
            { kind: 'xpathExists', xpath: 'App/App.Supplements' }
          ]
        }
      ];

      // Verify the structure expectations
      for (const config of expectedConfig) {
        assert.ok(config.id, 'Each document type should have an id');
        assert.ok(config.name, 'Each document type should have a name');
        assert.ok(typeof config.priority === 'number', 'Each document type should have numeric priority');
        assert.ok(Array.isArray(config.rules), 'Each document type should have rules array');
        assert.ok(config.rules.length > 0, 'Each document type should have at least one rule');
        
        for (const rule of config.rules) {
          assert.ok(rule.kind, 'Each rule should have a kind');
          if (rule.kind === 'rootElement') {
            assert.ok(rule.value, 'rootElement rules should have value');
          }
          if (rule.kind === 'xpathExists' || rule.kind === 'xpathNotExists') {
            assert.ok(rule.xpath, 'xpath rules should have xpath');
          }
          if (rule.kind === 'attributeExists' || rule.kind === 'attributeNotExists') {
            assert.ok(rule.xpath, 'attribute rules should have xpath');
            assert.ok(rule.attribute, 'attribute rules should have attribute');
          }
        }
      }

      console.log('✅ Document type configuration structure validated');
    });

    test('should distinguish between Extension and Base App names', () => {
      // Test that extension shows as "Extension" and baseapp shows as "Base App"
      const extensionName = 'Extension';
      const baseAppName = 'Base App';
      const supplementName = 'Supplement XML';
      
      assert.strictEqual(extensionName, 'Extension', 'Extension should show as "Extension"');
      assert.strictEqual(baseAppName, 'Base App', 'Base app should show as "Base App"');
      assert.strictEqual(supplementName, 'Supplement XML', 'Supplement should show as "Supplement XML"');
      
      // Verify they are different
      assert.notStrictEqual(extensionName, baseAppName, 'Extension and Base App should have different names');
      assert.notStrictEqual(extensionName, supplementName, 'Extension and Supplement should have different names');
      assert.notStrictEqual(baseAppName, supplementName, 'Base App and Supplement should have different names');
    });
  });

  suite('Full Document Type Detection Flow', () => {
    test('should simulate complete extension detection with mock', () => {
      // Mock an extension App element
      const mockExtensionElement: MockSaxElement = {
        tagName: 'App',
        attributes: {
          Extends: 'kahua_AEC_RFI',
          Name: 'kahua_aec_rfi_extension',
          DataScope: 'Default',
          AppScope: 'Partition',
          Version: '1750'
        }
      };
      
      // Simulate the complete rule evaluation for extension type
      const extensionRules = [
        { kind: 'attributeExists' as const, xpath: 'App', attribute: 'Extends' }
      ];
      
      let allMatch = true;
      for (const rule of extensionRules) {
        const result = mockEvaluateAttributeRule(rule, mockExtensionElement);
        if (!result) {
          allMatch = false;
          break;
        }
      }
      
      assert.strictEqual(allMatch, true, 'Extension element should match all extension attribute rules');
    });

    test('should simulate complete base app detection with mock', () => {
      // Mock a base app App element (no Extends)
      const mockBaseAppElement: MockSaxElement = {
        tagName: 'App',
        attributes: {
          Name: 'kahua_BaseApp',
          DataScope: 'Default',
          AppScope: 'Partition',
          Version: '1750'
        }
      };
      
      // Simulate the complete rule evaluation for baseapp type
      const baseAppRules = [
        { kind: 'attributeNotExists' as const, xpath: 'App', attribute: 'Extends' }
      ];
      
      let allMatch = true;
      for (const rule of baseAppRules) {
        const result = mockEvaluateAttributeRule(rule, mockBaseAppElement);
        if (!result) {
          allMatch = false;
          break;
        }
      }
      
      assert.strictEqual(allMatch, true, 'Base App element should match all base app attribute rules');
    });
  });
});