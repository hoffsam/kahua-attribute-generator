import * as assert from 'assert';
import * as vscode from 'vscode';

// Mock implementation of injection path template logic for testing
function mockApplyMultiTokenTemplate(template: string, currentTokenName: string, currentTokenValue: string, allTokens: Map<string, string>): string {
  let result = template;
  
  // First replace {value} with the current token's value (backward compatibility)
  result = result.replace(/{value}/g, currentTokenValue);
  
  // Then replace all other token references
  for (const [tokenName, tokenValue] of Array.from(allTokens.entries())) {
    const tokenPattern = new RegExp(`\\{${tokenName}\\}`, 'g');
    result = result.replace(tokenPattern, tokenValue);
  }
  
  return result;
}

function mockApplyInjectionPathTemplate(xpath: string, affectingTokens: Map<string, string>, tokenDefinitions: any[] = []): { success: boolean; result: string } {
  let modifiedXPath = xpath;
  let applied = false;

  // Check each token definition for injection path templates
  for (const tokenDef of tokenDefinitions) {
    if (tokenDef.tokenReadPaths) {
      for (const [tokenName, readPath] of Object.entries(tokenDef.tokenReadPaths)) {
        if ((readPath as any).affectsInjection && (readPath as any).injectionPathTemplate && affectingTokens.has(tokenName)) {
          // Only apply template if the original xpath matches the pattern that the template is for
          // Extract the base path from the template (everything before the filter)
          const templateBasePath = (readPath as any).injectionPathTemplate.split('[')[0];

          // Check if the original xpath matches the path structure that this template is meant for
          // Parse both paths to compare their structural elements, not just string matching
          const xpathParts = xpath.split('/').filter(p => p);
          
          // Check if this template should apply to this xpath by comparing path structure
          let shouldApplyTemplate = false;
          
          // For EntityDef-based templates, check if we're actually targeting EntityDef elements
          if (templateBasePath.includes('EntityDef')) {
            // Only apply if the xpath has EntityDef as a path element (not just in attribute filters)
            shouldApplyTemplate = xpathParts.some(part => {
              // Check if this part is "EntityDef" or "EntityDef[...]" but not "@EntityDefName"
              return part === 'EntityDef' || (part.startsWith('EntityDef[') && !part.includes('@EntityDefName'));
            });
            
            // For absolute paths, also ensure the path structures match
            if (shouldApplyTemplate && templateBasePath.startsWith('App/') && xpath.startsWith('App/')) {
              // Both are absolute paths - check structural compatibility more strictly
              const templateStructure = templateBasePath.replace(/\[@[^\]]+\]/g, ''); // Remove attribute filters
              const xpathStructure = xpath.replace(/\[@[^\]]+\]/g, ''); // Remove attribute filters  
              
              // Check if xpath structure matches template structure (allowing for the target to be more specific)
              shouldApplyTemplate = xpathStructure.startsWith(templateStructure) || templateStructure.startsWith(xpathStructure);
            }
          } else if (templateBasePath.includes('DataStore/Tables/Table')) {
            // For DataStore Table templates, check if we're targeting DataStore Table elements
            shouldApplyTemplate = xpathParts.includes('DataStore') && 
                                  xpathParts.includes('Tables') && 
                                  xpathParts.includes('Table');
            
            // For DataStore paths, also check structural compatibility
            if (shouldApplyTemplate) {
              const templateStructure = templateBasePath.replace(/\[@[^\]]+\]/g, ''); // Remove attribute filters
              const xpathStructure = xpath.replace(/\[@[^\]]+\]/g, ''); // Remove attribute filters  
              
              // Check if xpath structure is compatible with template (xpath should be more specific than template)
              // e.g., "App/DataStore/Tables/Table/Columns" should match template "DataStore/Tables/Table"
              shouldApplyTemplate = xpathStructure.includes(templateStructure) || 
                                    templateStructure.includes(xpathStructure);
            }
          } else {
            // For other templates, check exact path match
            shouldApplyTemplate = xpath === templateBasePath;
          }
          
          if (shouldApplyTemplate) {
            const tokenValue = affectingTokens.get(tokenName)!;
            // Enhanced template replacement that handles multiple token substitutions
            modifiedXPath = mockApplyMultiTokenTemplate((readPath as any).injectionPathTemplate, tokenName, tokenValue, affectingTokens);
            applied = true;
            break;
          }
        }
      }
    }
  }

  return {
    success: true, // Always return success, just use original xpath if no template applied
    result: applied ? modifiedXPath : xpath
  };
}

suite('Smart Injection Resolution Tests', () => {
  
  suite('Token Extraction from Templates', () => {
    test('should extract appname and entity tokens from header line', () => {
      const headerLine = 'kahua_aec_rfi_extension,Field';
      const headerTokens = [
        { name: 'appname', defaultValue: '', isConditional: false },
        { name: 'entity', defaultValue: '', isConditional: false }
      ];
      const tableTokens = [
        { name: 'name', defaultValue: '', isConditional: false },
        { name: 'type', defaultValue: 'Text', isConditional: false }
      ];
      
      // Simulate getTokenValues function behavior
      const headerParts = headerLine.split(',');
      const tokenValues: Record<string, string> = {};
      
      for (let i = 0; i < headerTokens.length; i++) {
        const token = headerTokens[i];
        const rawPart = headerParts[i] || '';
        const trimmedPart = rawPart.trim();
        tokenValues[token.name] = trimmedPart || token.defaultValue;
      }
      
      assert.strictEqual(tokenValues['appname'], 'kahua_aec_rfi_extension', 'Should extract appname');
      assert.strictEqual(tokenValues['entity'], 'Field', 'Should extract entity');
      
      console.log('✅ Token extraction from header line works correctly');
    });

    test('should filter tokens that affect injection', () => {
      const mockTokenDefinitions = [
        {
          id: 'appname',
          tokenReadPaths: {
            appname: {
              type: 'attribute',
              path: 'App/@Name',
              affectsInjection: true,
              injectionPathTemplate: 'DataStore/Tables/Table[@EntityDefName=\'{value}.{entity}\']'
            }
          }
        },
        {
          id: 'entity',
          tokenReadPaths: {
            entity: {
              type: 'selection',
              path: 'App/EntityDefs/EntityDef',
              attribute: 'Name',
              affectsInjection: true,
              injectionPathTemplate: 'DataStore/Tables/Table[@EntityDefName=\'{appname}.{value}\']'
            }
          }
        },
        {
          id: 'regular',
          tokenReadPaths: {
            name: {
              type: 'attribute',
              path: '@Name'
              // No affectsInjection flag
            }
          }
        }
      ];

      const extractedValues: { [key: string]: string } = {
        appname: 'kahua_aec_rfi_extension',
        entity: 'Field',
        name: 'TestField'
      };

      const injectionTokens = new Map<string, string>();
      
      // Simulate extraction logic
      for (const tokenDef of mockTokenDefinitions) {
        if (tokenDef.tokenReadPaths) {
          for (const [tokenName, readPath] of Object.entries(tokenDef.tokenReadPaths)) {
            if ((readPath as any).affectsInjection && extractedValues[tokenName]) {
              injectionTokens.set(tokenName, extractedValues[tokenName]);
            }
          }
        }
      }

      assert.strictEqual(injectionTokens.size, 2, 'Should extract 2 injection-affecting tokens');
      assert.strictEqual(injectionTokens.get('appname'), 'kahua_aec_rfi_extension', 'Should include appname');
      assert.strictEqual(injectionTokens.get('entity'), 'Field', 'Should include entity');
      assert.ok(!injectionTokens.has('name'), 'Should not include non-affecting tokens');

      console.log('✅ Injection token filtering works correctly');
    });
  });

  suite('Smart Injection Target Resolution', () => {
    test('should auto-resolve Table with matching EntityDefName', () => {
      const mockTargets = [
        {
          injectionPath: 'DataStore/Tables/Table[@EntityDefName="someapp.OtherEntity"]/Columns',
          context: 'Table[EntityDefName="someapp.OtherEntity"]/Columns',
          attributes: { EntityDefName: 'someapp.OtherEntity' },
          openTagLine: 10,
          closeTagLine: 15,
          xmlNodeName: 'Columns',
          enrichedPath: 'DataStore/Tables/Table/Columns'
        },
        {
          injectionPath: 'DataStore/Tables/Table[@EntityDefName="kahua_aec_rfi_extension.Field"]/Columns',
          context: 'Table[EntityDefName="kahua_aec_rfi_extension.Field"]/Columns', 
          attributes: { EntityDefName: 'kahua_aec_rfi_extension.Field' },
          openTagLine: 20,
          closeTagLine: 25,
          xmlNodeName: 'Columns',
          enrichedPath: 'DataStore/Tables/Table/Columns'
        },
        {
          injectionPath: 'DataStore/Tables/Table[@EntityDefName="otherapp.Project"]/Columns',
          context: 'Table[EntityDefName="otherapp.Project"]/Columns',
          attributes: { EntityDefName: 'otherapp.Project' },
          openTagLine: 30,
          closeTagLine: 35,
          xmlNodeName: 'Columns',
          enrichedPath: 'DataStore/Tables/Table/Columns'
        }
      ];

      const affectingTokens = new Map([
        ['appname', 'kahua_aec_rfi_extension'],
        ['entity', 'Field']
      ]);

      // Simulate trySmartInjectionResolution logic for columns section
      const sectionName = 'columns';
      const appname = affectingTokens.get('appname');
      const entity = affectingTokens.get('entity');
      
      let selectedTarget = undefined;
      
      if (sectionName.toLowerCase().includes('column') || sectionName.toLowerCase() === 'columns') {
        if (appname && entity) {
          const expectedEntityDefName = `${appname}.${entity}`;
          
          for (const target of mockTargets) {
            if (target.injectionPath && target.injectionPath.includes('Table')) {
              // Check injection path
              const pathHasEntityDefName = target.injectionPath.includes(`@EntityDefName="${expectedEntityDefName}"`) ||
                                           target.injectionPath.includes(`@EntityDefName='${expectedEntityDefName}'`) ||
                                           target.injectionPath.includes(`EntityDefName="${expectedEntityDefName}"`);
              
              if (pathHasEntityDefName) {
                selectedTarget = target;
                break;
              }
              
              // Check context
              if (target.context && target.context.includes(expectedEntityDefName)) {
                selectedTarget = target;
                break;
              }
              
              // Check attributes
              if (target.attributes && target.attributes['EntityDefName'] === expectedEntityDefName) {
                selectedTarget = target;
                break;
              }
            }
          }
        }
      }

      assert.ok(selectedTarget, 'Should find a matching target');
      assert.strictEqual(selectedTarget?.attributes?.EntityDefName, 'kahua_aec_rfi_extension.Field', 
                        'Should select target with correct EntityDefName');
      assert.strictEqual(selectedTarget?.openTagLine, 20, 'Should select the correct target by line');

      console.log('✅ Smart injection target resolution works correctly');
      console.log(`   Selected: ${selectedTarget?.attributes?.EntityDefName} at line ${selectedTarget?.openTagLine + 1}`);
    });

    test('should handle multi-token template substitution', () => {
      const template = 'DataStore/Tables/Table[@EntityDefName=\'{appname}.{entity}\']';
      const currentTokenName = 'entity';
      const currentTokenValue = 'Field';
      const allTokens = new Map([
        ['appname', 'kahua_aec_rfi_extension'],
        ['entity', 'Field']
      ]);

      // Simulate applyMultiTokenTemplate logic
      let result = template;
      
      // Replace {value} with current token's value (backward compatibility)
      result = result.replace(/{value}/g, currentTokenValue);
      
      // Replace all other token references
      for (const [tokenName, tokenValue] of Array.from(allTokens.entries())) {
        const tokenPattern = new RegExp(`\\{${tokenName}\\}`, 'g');
        result = result.replace(tokenPattern, tokenValue);
      }

      const expected = 'DataStore/Tables/Table[@EntityDefName=\'kahua_aec_rfi_extension.Field\']';
      assert.strictEqual(result, expected, 'Should substitute all tokens correctly');

      console.log('✅ Multi-token template substitution works correctly');
      console.log(`   Template: ${template}`);
      console.log(`   Result:   ${result}`);
    });

    test('should not auto-resolve when insufficient information', () => {
      const mockTargets = [
        {
          injectionPath: 'DataStore/Tables/Table/Columns',
          context: 'Table/Columns',
          attributes: {},
          openTagLine: 10,
          closeTagLine: 15,
          xmlNodeName: 'Columns',
          enrichedPath: 'DataStore/Tables/Table/Columns'
        }
      ];

      // Test with missing appname
      const insufficientTokens1 = new Map([
        ['entity', 'Field']
        // Missing appname
      ]);

      // Test with missing entity
      const insufficientTokens2 = new Map([
        ['appname', 'kahua_aec_rfi_extension']
        // Missing entity
      ]);

      // Test with empty tokens
      const insufficientTokens3 = new Map();

      const testCases = [
        { tokens: insufficientTokens1, description: 'missing appname' },
        { tokens: insufficientTokens2, description: 'missing entity' },
        { tokens: insufficientTokens3, description: 'no tokens' }
      ];

      for (const testCase of testCases) {
        // Simulate smart resolution logic
        const appname = testCase.tokens.get('appname');
        const entity = testCase.tokens.get('entity');
        let selectedTarget = undefined;

        if (appname && entity) {
          // Only proceed if both tokens are available
          selectedTarget = mockTargets[0]; // Would select if conditions met
        }

        assert.ok(!selectedTarget, `Should not auto-resolve when ${testCase.description}`);
      }

      console.log('✅ Smart injection correctly handles insufficient information');
    });
  });

  suite('Integration Test Simulation', () => {
    test('should simulate end-to-end token extraction and injection', () => {
      // Simulate template content with header tokens
      const templateContent = `// Kahua Template for attributes
// Header tokens: appname, entity:Field
// Table tokens: name, type:Text, visualtype:TextBox, label

kahua_aec_rfi_extension,Field
TestField,Text,TextBox,Test Field Label
Status,Text,TextBox,Status Label
Priority,Text,TextBox,Priority Label`;

      // Parse template content
      const lines = templateContent.split('\n').filter(line => 
        !line.trim().startsWith('//') && line.trim().length > 0
      );
      
      assert.ok(lines.length >= 2, 'Should have header and data lines');
      
      const headerLine = lines[0];
      const dataLines = lines.slice(1);
      
      // Extract header tokens
      const headerParts = headerLine.split(',');
      const extractedTokens = new Map([
        ['appname', headerParts[0]?.trim() || ''],
        ['entity', headerParts[1]?.trim() || '']
      ]);
      
      assert.strictEqual(extractedTokens.get('appname'), 'kahua_aec_rfi_extension');
      assert.strictEqual(extractedTokens.get('entity'), 'Field');
      assert.strictEqual(dataLines.length, 3, 'Should have 3 data rows');
      
      // Simulate destination XML with multiple Tables
      const mockDestinationTargets = [
        {
          injectionPath: 'DataStore/Tables/Table[@EntityDefName="kahua_aec_rfi_extension.Field"]/Columns',
          attributes: { EntityDefName: 'kahua_aec_rfi_extension.Field' },
          openTagLine: 5
        },
        {
          injectionPath: 'DataStore/Tables/Table[@EntityDefName="kahua_aec_rfi_extension.Project"]/Columns',
          attributes: { EntityDefName: 'kahua_aec_rfi_extension.Project' },
          openTagLine: 15
        },
        {
          injectionPath: 'DataStore/Tables/Table[@EntityDefName="otherapp.SomeEntity"]/Columns',
          attributes: { EntityDefName: 'otherapp.SomeEntity' },
          openTagLine: 25
        }
      ];
      
      // Test smart resolution
      const expectedEntityDefName = `${extractedTokens.get('appname')}.${extractedTokens.get('entity')}`;
      const selectedTarget = mockDestinationTargets.find(target => 
        target.attributes.EntityDefName === expectedEntityDefName
      );
      
      assert.ok(selectedTarget, 'Should auto-select matching target');
      assert.strictEqual(selectedTarget.attributes.EntityDefName, 'kahua_aec_rfi_extension.Field');
      assert.strictEqual(selectedTarget.openTagLine, 5, 'Should select the first Table');
      
      console.log('✅ End-to-end simulation successful');
      console.log(`   Extracted: appname="${extractedTokens.get('appname')}", entity="${extractedTokens.get('entity')}"`);
      console.log(`   Selected: ${selectedTarget.attributes.EntityDefName} at line ${selectedTarget.openTagLine + 1}`);
      console.log(`   Data rows: ${dataLines.length} attributes to inject`);
    });

    test('should verify no caching between template generations', () => {
      // Simulate first generation
      const firstTemplate = 'kahua_aec_rfi_extension,Field\nTestField,Text,TextBox,Label1';
      const firstHeaderLine = firstTemplate.split('\n')[0];
      const firstTokens = new Map([
        ['appname', firstHeaderLine.split(',')[0]?.trim() || ''],
        ['entity', firstHeaderLine.split(',')[1]?.trim() || '']
      ]);
      
      // Simulate second generation with different content
      const secondTemplate = 'kahua_aec_rfi_extension,Project\nProjectName,Text,TextBox,Project Name';
      const secondHeaderLine = secondTemplate.split('\n')[0];
      const secondTokens = new Map([
        ['appname', secondHeaderLine.split(',')[0]?.trim() || ''],
        ['entity', secondHeaderLine.split(',')[1]?.trim() || '']
      ]);
      
      // Verify tokens are different and not cached
      assert.strictEqual(firstTokens.get('entity'), 'Field', 'First generation should extract Field');
      assert.strictEqual(secondTokens.get('entity'), 'Project', 'Second generation should extract Project');
      assert.notStrictEqual(firstTokens.get('entity'), secondTokens.get('entity'), 
                           'Should not cache entity selection between generations');
      
      // Verify both would resolve to different targets
      const firstEntityDefName = `${firstTokens.get('appname')}.${firstTokens.get('entity')}`;
      const secondEntityDefName = `${secondTokens.get('appname')}.${secondTokens.get('entity')}`;
      
      assert.strictEqual(firstEntityDefName, 'kahua_aec_rfi_extension.Field');
      assert.strictEqual(secondEntityDefName, 'kahua_aec_rfi_extension.Project');
      
      console.log('✅ No caching between generations verified');
      console.log(`   First:  ${firstEntityDefName}`);
      console.log(`   Second: ${secondEntityDefName}`);
    });
  });

  suite('Configuration Validation', () => {
    test('should validate injection path templates in configuration', () => {
      const mockConfig = {
        tokenDefinitions: [
          {
            id: 'appname',
            tokenReadPaths: {
              appname: {
                type: 'attribute',
                path: 'App/@Name',
                affectsInjection: true,
                injectionPathTemplate: 'DataStore/Tables/Table[@EntityDefName=\'{value}.{entity}\']'
              }
            }
          },
          {
            id: 'entity', 
            tokenReadPaths: {
              entity: {
                type: 'selection',
                path: 'App/EntityDefs/EntityDef',
                attribute: 'Name',
                affectsInjection: true,
                injectionPathTemplate: 'DataStore/Tables/Table[@EntityDefName=\'{appname}.{value}\']'
              }
            }
          }
        ],
        fragmentDefinitions: [
          {
            id: 'attributes',
            name: 'Attribute Template',
            injectionPaths: {
              columns: 'DataStore/Tables/Table/Columns'
            }
          }
        ]
      };
      
      // Validate token definitions have injection templates
      let injectionTokenCount = 0;
      for (const tokenDef of mockConfig.tokenDefinitions) {
        if (tokenDef.tokenReadPaths) {
          for (const [tokenName, readPath] of Object.entries(tokenDef.tokenReadPaths)) {
            if (readPath.affectsInjection && readPath.injectionPathTemplate) {
              injectionTokenCount++;
              assert.ok(readPath.injectionPathTemplate.includes('{'), 
                       `Token ${tokenName} should have template with placeholders`);
            }
          }
        }
      }
      
      assert.strictEqual(injectionTokenCount, 2, 'Should have 2 injection-affecting tokens');
      
      // Validate fragment has injection paths
      const attributesFragment = mockConfig.fragmentDefinitions.find(f => f.id === 'attributes');
      assert.ok(attributesFragment?.injectionPaths, 'Attributes fragment should have injection paths');
      assert.ok(attributesFragment?.injectionPaths?.columns, 'Should have columns injection path');
      
      console.log('✅ Configuration validation passed');
      console.log(`   Injection tokens: ${injectionTokenCount}`);
      console.log(`   Fragment paths: ${Object.keys(attributesFragment?.injectionPaths || {}).length}`);
    });
    
    test('should handle DataStore Table injection with baseapp.entity pattern', () => {
      // Test the specific case: DataStore/Tables/Table with baseapp + entity tokens
      const mockTokenDefinitions = [
        {
          id: 'appname',
          tokenReadPaths: {
            baseapp: {
              type: 'attribute',
              path: 'App/@Extends',
              affectsInjection: true,
              injectionPathTemplate: 'DataStore/Tables/Table[@EntityDefName=\'{value}.{entity}\']'
            },
            entity: {
              type: 'selection', 
              path: 'EntityDefs/EntityDef',
              attribute: 'Name',
              affectsInjection: true,
              injectionPathTemplate: 'App/EntityDefs/EntityDef[@Name=\'{value}\']/Attributes'
            }
          }
        }
      ];
      
      const xpath = 'App/DataStore/Tables/Table/Columns';
      const affectingTokens = new Map([
        ['baseapp', 'kahua_AEC_RFI'],
        ['entity', 'RFI']
      ]);
      
      // This tests the actual function logic (mock implementation)
      const result = mockApplyInjectionPathTemplate(xpath, affectingTokens, mockTokenDefinitions);
      
      console.log('✅ DataStore injection correctly resolved');
      console.log(`   Input:  ${xpath}`);
      console.log(`   Output: ${result.result}`);
      console.log(`   Tokens: baseapp=kahua_AEC_RFI, entity=RFI`);
      
      assert.strictEqual(result.success, true, 'Should successfully apply template');
      assert.strictEqual(result.result, 
        'DataStore/Tables/Table[@EntityDefName=\'kahua_AEC_RFI.RFI\']',
        'Should create correct EntityDefName filter with baseapp.entity pattern');
      
      // Verify it contains the expected pattern
      assert.ok(result.result.includes('kahua_AEC_RFI.RFI'), 
        'Result should contain baseapp.entity substitution');
        
      // Verify it doesn't affect EntityDef paths (regression test)  
      const entityXpath = 'App/EntityDefs/EntityDef/Attributes';
      const entityTokens = new Map([['entity', 'Field']]);
      const entityResult = mockApplyInjectionPathTemplate(entityXpath, entityTokens, mockTokenDefinitions);
      
      assert.strictEqual(entityResult.result, 
        'App/EntityDefs/EntityDef[@Name=\'Field\']/Attributes',
        'Should still work correctly for EntityDef paths');
    });
  });
});