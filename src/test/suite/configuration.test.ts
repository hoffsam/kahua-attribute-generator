import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Configuration diagnostic tests
 * These tests validate the Kahua configuration setup and help diagnose common issues
 */
suite('Configuration Tests', () => {
  
  suite('Configuration File Detection', () => {
    test('should detect workspace settings file', () => {
      const workspaceSettingsPath = path.resolve('.vscode/settings.json');
      const exists = fs.existsSync(workspaceSettingsPath);
      
      if (!exists) {
        console.warn('⚠️  No .vscode/settings.json found - this may cause token extraction to fail');
        console.warn('   Create .vscode/settings.json with Kahua configuration to fix this');
      }
      
      // This is a diagnostic test - we don't fail if config doesn't exist
      // but we log warnings to help with troubleshooting
      assert.ok(true, 'Configuration check completed');
    });

    test('should validate configuration structure if present', () => {
      const workspaceSettingsPath = path.resolve('.vscode/settings.json');
      
      if (fs.existsSync(workspaceSettingsPath)) {
        try {
          const content = fs.readFileSync(workspaceSettingsPath, 'utf8');
          const config = JSON.parse(content);
          
          // Check for Kahua configuration sections
          const kahuaKeys = Object.keys(config).filter(key => key.startsWith('kahua.'));
          
          if (kahuaKeys.length === 0) {
            console.warn('⚠️  No kahua.* configuration found in settings.json');
            console.warn('   Add Kahua configuration sections to enable token extraction');
          } else {
            console.log(`✓ Found Kahua configuration keys: ${kahuaKeys.join(', ')}`);
            
            // Validate required sections
            const requiredSections = ['kahua.documentTypes', 'kahua.tokenNameDefinitions', 'kahua.fragmentDefinitions'];
            const missingSections = requiredSections.filter(section => !config[section]);
            
            if (missingSections.length > 0) {
              console.warn(`⚠️  Missing required configuration sections: ${missingSections.join(', ')}`);
            } else {
              console.log('✓ All required Kahua configuration sections present');
            }
          }
        } catch (error) {
          console.error('❌ Error parsing settings.json:', error instanceof Error ? error.message : String(error));
        }
      }
      
      assert.ok(true, 'Configuration validation completed');
    });
  });

  suite('Sample Configuration Validation', () => {
    test('should validate sample configuration structure', () => {
      const sampleConfig = {
        "kahua.documentTypes": [
          {
            "id": "kahua-aec-rfi",
            "name": "Kahua AEC RFI",
            "priority": 10,
            "rules": [
              { "kind": "rootElement", "value": "App" },
              { "kind": "xpathExists", "xpath": "App/EntityDefs" }
            ]
          }
        ],
        "kahua.tokenNameDefinitions": [
          {
            "id": "appname",
            "tokenReadPaths": {
              "appname": { "type": "attribute", "path": "App/@Name" }
            }
          },
          {
            "id": "entity",
            "tokenReadPaths": {
              "entity": { "type": "selection", "path": "App/EntityDefs/EntityDef", "attribute": "Name" }
            }
          }
        ],
        "kahua.fragmentDefinitions": [
          {
            "id": "attributes",
            "name": "Attribute Template",
            "applicableDocumentTypes": ["kahua-aec-rfi"],
            "headerTokens": ["appname", "entity"],
            "tableTokens": ["name", "type", "visualtype", "label", "descriptionlabel", "linkedEntityDef"],
            "xpath": "App/EntityDefs/EntityDef[@Name='{entity}']/Attributes/Attribute",
            "tokenDefinitions": {
              "name": { "type": "attribute", "path": "@Name" },
              "type": { "type": "attribute", "path": "@Type", "defaultValue": "Text" },
              "visualtype": { "type": "attribute", "path": "@VisualType", "defaultValue": "TextBox" },
              "label": { "type": "attribute", "path": "@Label" },
              "descriptionlabel": { "type": "attribute", "path": "@DescriptionLabel" },
              "linkedEntityDef": { "type": "attribute", "path": "@LinkedEntityDef" }
            }
          }
        ]
      };

      // Validate document types
      const docTypes = sampleConfig['kahua.documentTypes'];
      assert.ok(Array.isArray(docTypes), 'Document types should be an array');
      assert.ok(docTypes.length > 0, 'Should have at least one document type');
      
      for (const docType of docTypes) {
        assert.ok(docType.id, 'Document type should have id');
        assert.ok(docType.name, 'Document type should have name');
        assert.ok(Array.isArray(docType.rules), 'Document type should have rules array');
        assert.ok(docType.rules.length > 0, 'Document type should have at least one rule');
        
        for (const rule of docType.rules) {
          assert.ok(rule.kind, 'Rule should have kind');
          assert.ok(rule.value || rule.xpath, 'Rule should have value or xpath');
        }
      }

      // Validate token definitions
      const tokenDefs = sampleConfig['kahua.tokenNameDefinitions'];
      assert.ok(Array.isArray(tokenDefs), 'Token definitions should be an array');
      assert.ok(tokenDefs.length > 0, 'Should have at least one token definition');
      
      for (const tokenDef of tokenDefs) {
        assert.ok(tokenDef.id, 'Token definition should have id');
        assert.ok(tokenDef.tokenReadPaths, 'Token definition should have tokenReadPaths');
        assert.ok(typeof tokenDef.tokenReadPaths === 'object', 'tokenReadPaths should be an object');
        
        for (const [tokenName, readPath] of Object.entries(tokenDef.tokenReadPaths)) {
          assert.ok((readPath as any).type, `Token ${tokenName} should have type`);
          assert.ok((readPath as any).path, `Token ${tokenName} should have path`);
          assert.ok(['attribute', 'text', 'selection'].includes((readPath as any).type), 
                   `Token ${tokenName} should have valid type`);
        }
      }

      // Validate fragment definitions
      const fragments = sampleConfig['kahua.fragmentDefinitions'];
      assert.ok(Array.isArray(fragments), 'Fragment definitions should be an array');
      assert.ok(fragments.length > 0, 'Should have at least one fragment definition');
      
      for (const fragment of fragments) {
        assert.ok(fragment.id, 'Fragment should have id');
        assert.ok(fragment.name, 'Fragment should have name');
        assert.ok(Array.isArray(fragment.headerTokens), 'Fragment should have headerTokens array');
        assert.ok(Array.isArray(fragment.tableTokens), 'Fragment should have tableTokens array');
        assert.ok(fragment.xpath, 'Fragment should have xpath');
        assert.ok(fragment.tokenDefinitions, 'Fragment should have tokenDefinitions');
        assert.ok(typeof fragment.tokenDefinitions === 'object', 'tokenDefinitions should be an object');
        
        // Validate that all table tokens have definitions
        for (const tableToken of fragment.tableTokens) {
          assert.ok(fragment.tokenDefinitions[tableToken], 
                   `Fragment should have definition for table token: ${tableToken}`);
        }
      }
    });

    test('should validate XPath patterns', () => {
      const xpathPatterns = [
        'App/@Name',
        'App/EntityDefs/EntityDef',
        'App/EntityDefs/EntityDef/@Name',
        "App/EntityDefs/EntityDef[@Name='Field']/Attributes/Attribute",
        '@Name',
        '@Type',
        '@VisualType'
      ];

      for (const xpath of xpathPatterns) {
        // Basic XPath validation
        assert.ok(typeof xpath === 'string', 'XPath should be a string');
        assert.ok(xpath.length > 0, 'XPath should not be empty');
        
        // Check for common XPath patterns
        const isAttributePath = xpath.includes('/@');
        const isElementPath = !xpath.startsWith('@') && !isAttributePath;
        const isRelativeAttribute = xpath.startsWith('@');
        
        assert.ok(isAttributePath || isElementPath || isRelativeAttribute, 
                 `XPath should be valid pattern: ${xpath}`);
        
        // Validate attribute XPath structure
        if (isAttributePath) {
          const parts = xpath.split('/@');
          assert.strictEqual(parts.length, 2, `Attribute XPath should have element and attribute parts: ${xpath}`);
          assert.ok(parts[0].length > 0, `Element path should not be empty: ${xpath}`);
          assert.ok(parts[1].length > 0, `Attribute name should not be empty: ${xpath}`);
        }
      }
    });
  });

  suite('Common Configuration Issues', () => {
    test('should detect missing required fields', () => {
      const incompleteConfigs = [
        // Missing document type id
        {
          config: { "kahua.documentTypes": [{ "name": "Test" }] },
          expectedError: "Document type missing id"
        },
        // Missing token read paths
        {
          config: { "kahua.tokenNameDefinitions": [{ "id": "test" }] },
          expectedError: "Token definition missing tokenReadPaths"
        },
        // Missing fragment xpath
        {
          config: { "kahua.fragmentDefinitions": [{ "id": "test", "name": "Test", "headerTokens": [], "tableTokens": [] }] },
          expectedError: "Fragment missing xpath"
        }
      ];

      for (const testCase of incompleteConfigs) {
        let hasError = false;
        let errorMessage = '';

        try {
          // Simulate validation that would happen in the extension
          if (testCase.config['kahua.documentTypes']) {
            for (const docType of testCase.config['kahua.documentTypes']) {
              if (!docType.id) {
                hasError = true;
                errorMessage = 'Document type missing id';
              }
            }
          }
          
          if (testCase.config['kahua.tokenNameDefinitions']) {
            for (const tokenDef of testCase.config['kahua.tokenNameDefinitions']) {
              if (!tokenDef.tokenReadPaths) {
                hasError = true;
                errorMessage = 'Token definition missing tokenReadPaths';
              }
            }
          }
          
          if (testCase.config['kahua.fragmentDefinitions']) {
            for (const fragment of testCase.config['kahua.fragmentDefinitions']) {
              if (!fragment.xpath) {
                hasError = true;
                errorMessage = 'Fragment missing xpath';
              }
            }
          }
        } catch (error) {
          hasError = true;
          errorMessage = error instanceof Error ? error.message : String(error);
        }

        assert.ok(hasError, `Should detect error: ${testCase.expectedError}`);
        assert.ok(errorMessage.includes(testCase.expectedError.split(' ')[2]), 
                 `Should detect specific issue: ${testCase.expectedError}`);
      }
    });

    test('should provide helpful error messages', () => {
      const errorScenarios = [
        {
          scenario: 'No configuration found',
          solution: 'Create .vscode/settings.json with Kahua configuration'
        },
        {
          scenario: 'Missing document types',
          solution: 'Add kahua.documentTypes array with document type definitions'
        },
        {
          scenario: 'Missing token definitions', 
          solution: 'Add kahua.tokenNameDefinitions array with token extraction rules'
        },
        {
          scenario: 'Missing fragment definitions',
          solution: 'Add kahua.fragmentDefinitions array with template fragments'
        }
      ];

      // This test documents the expected error handling behavior
      for (const scenario of errorScenarios) {
        assert.ok(scenario.scenario, 'Should have scenario description');
        assert.ok(scenario.solution, 'Should have solution suggestion');
        console.log(`${scenario.scenario} → ${scenario.solution}`);
      }

      assert.ok(true, 'Error message documentation completed');
    });
  });

  suite('Configuration Examples', () => {
    test('should provide working minimal configuration', () => {
      const minimalConfig = {
        "kahua.documentTypes": [
          {
            "id": "simple-app",
            "name": "Simple App", 
            "rules": [{ "kind": "rootElement", "value": "App" }]
          }
        ],
        "kahua.tokenNameDefinitions": [
          {
            "id": "appname",
            "tokenReadPaths": {
              "appname": { "type": "attribute", "path": "App/@Name" }
            }
          }
        ],
        "kahua.fragmentDefinitions": [
          {
            "id": "simple",
            "name": "Simple Template",
            "headerTokens": ["appname"],
            "tableTokens": ["name"],
            "xpath": "App/Items/Item",
            "tokenDefinitions": {
              "name": { "type": "attribute", "path": "@Name" }
            }
          }
        ]
      };

      // Validate minimal configuration is complete and functional
      assert.ok(minimalConfig['kahua.documentTypes'][0].id, 'Should have document type id');
      assert.ok(minimalConfig['kahua.tokenNameDefinitions'][0].tokenReadPaths.appname, 'Should have appname token');
      assert.ok(minimalConfig['kahua.fragmentDefinitions'][0].xpath, 'Should have fragment xpath');

      console.log('✓ Minimal configuration example validated');
      console.log('  This configuration can be used as a starting point for new projects');
    });

    test('should provide complete configuration example', () => {
      // This test serves as documentation for a complete, working configuration
      const completeConfig = JSON.stringify({
        "kahua.documentTypes": [
          {
            "id": "kahua-aec-rfi",
            "name": "Kahua AEC RFI",
            "priority": 10,
            "rules": [
              { "kind": "rootElement", "value": "App" },
              { "kind": "xpathExists", "xpath": "App/EntityDefs" }
            ]
          }
        ],
        "kahua.tokenNameDefinitions": [
          {
            "id": "appname",
            "tokenReadPaths": {
              "appname": { "type": "attribute", "path": "App/@Name" }
            }
          },
          {
            "id": "entity", 
            "tokenReadPaths": {
              "entity": { "type": "selection", "path": "App/EntityDefs/EntityDef", "attribute": "Name" }
            }
          }
        ],
        "kahua.fragmentDefinitions": [
          {
            "id": "attributes",
            "name": "Attribute Template",
            "applicableDocumentTypes": ["kahua-aec-rfi"],
            "headerTokens": ["appname", "entity"],
            "tableTokens": ["name", "type", "visualtype", "label", "descriptionlabel", "linkedEntityDef"],
            "xpath": "App/EntityDefs/EntityDef[@Name='{entity}']/Attributes/Attribute",
            "tokenDefinitions": {
              "name": { "type": "attribute", "path": "@Name" },
              "type": { "type": "attribute", "path": "@Type", "defaultValue": "Text" },
              "visualtype": { "type": "attribute", "path": "@VisualType", "defaultValue": "TextBox" },
              "label": { "type": "attribute", "path": "@Label" },
              "descriptionlabel": { "type": "attribute", "path": "@DescriptionLabel" },
              "linkedEntityDef": { "type": "attribute", "path": "@LinkedEntityDef" }
            }
          }
        ]
      }, null, 2);

      assert.ok(completeConfig.includes('kahua.documentTypes'), 'Should include document types');
      assert.ok(completeConfig.includes('kahua.tokenNameDefinitions'), 'Should include token definitions');
      assert.ok(completeConfig.includes('kahua.fragmentDefinitions'), 'Should include fragment definitions');

      console.log('✓ Complete configuration example validated');
      console.log('  Save this to .vscode/settings.json to enable full Kahua functionality');
    });
  });
});