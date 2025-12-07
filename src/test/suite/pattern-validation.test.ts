/**
 * Pattern Validation Tests (Option B)
 * Tests smart injection resolution WITH section path pattern validation
 */

import * as assert from 'assert';
import { __testSmartInjectionResolution } from '../../extension';

suite('Pattern Validation Tests (Smart Injection with Section Pattern)', () => {
  
  // Enhanced test helper that includes section pattern
  function testSmartInjectionWithPattern(
    sectionName: string,
    sectionPattern: string | undefined,
    targets: any[],
    tokens: Map<string, string>,
    tokenDefinitions: any[]
  ): any | undefined {
    // Pass the section pattern to the resolution logic
    return __testSmartInjectionWithPattern(
      sectionName,
      sectionPattern,
      targets,
      tokens,
      tokenDefinitions
    );
  }
  
  suite('DataStore Section with EntityDefName Pattern', () => {
    
    const tokenDefs = [{
      id: 'smart',
      name: 'Smart Tokens',
      type: 'header',
      tokens: 'appname,entity',
      tokenReadPaths: {
        appname: {
          type: 'attribute',
          readpaths: ['App/@Name'],
          injectionmatchpaths: ['App/@Name', 'App/@Extends'],
          affectsInjection: true
        },
        entity: {
          type: 'selection',
          readpaths: ['App/EntityDefs/EntityDef'],
          attribute: 'Name',
          affectsInjection: true
        }
      }
    }];
    
    test('auto-resolves when App Name matches pattern', () => {
      const tokens = new Map([
        ['appname', 'kahua_AEC_RFI'],
        ['entity', 'RFI']
      ]);
      
      const target = createDataStoreTarget('kahua_AEC_RFI.RFI', {
        Name: 'kahua_AEC_RFI'
      });
      
      const sectionPattern = "Table[@EntityDefName='{appname}.{entity}']";
      
      const result = testSmartInjectionWithPattern(
        'DataStore',
        sectionPattern,
        [target],
        tokens,
        tokenDefs
      );
      
      assert.strictEqual(result, target, 'Should auto-resolve when Name matches pattern');
    });
    
    test('auto-resolves when App Extends matches pattern', () => {
      const tokens = new Map([
        ['appname', 'kahua_AEC_RFI'],
        ['entity', 'RFI']
      ]);
      
      const target = createDataStoreTarget('kahua_AEC_RFI.RFI', {
        Name: 'kahua_aec_rfi_extension',
        Extends: 'kahua_AEC_RFI'
      });
      
      const sectionPattern = "Table[@EntityDefName='{appname}.{entity}']";
      
      const result = testSmartInjectionWithPattern(
        'DataStore',
        sectionPattern,
        [target],
        tokens,
        tokenDefs
      );
      
      assert.strictEqual(result, target, 'Should auto-resolve when Extends matches pattern');
    });
    
    test('does NOT auto-resolve when pattern does not match', () => {
      const tokens = new Map([
        ['appname', 'kahua_aec_rfi_extension'],  // Extension name
        ['entity', 'RFI']
      ]);
      
      const target = createDataStoreTarget('kahua_AEC_RFI.RFI', {  // Base app name in EntityDefName
        Name: 'kahua_aec_rfi_extension',
        Extends: 'kahua_AEC_RFI'
      });
      
      const sectionPattern = "Table[@EntityDefName='{appname}.{entity}']";
      
      // With ONLY Name allowed (no Extends fallback)
      const nameOnlyDefs = [{
        ...tokenDefs[0],
        tokenReadPaths: {
          appname: {
            ...tokenDefs[0].tokenReadPaths.appname,
            injectionmatchpaths: ['App/@Name']  // No Extends!
          },
          entity: tokenDefs[0].tokenReadPaths.entity
        }
      }];
      
      const result = testSmartInjectionWithPattern(
        'DataStore',
        sectionPattern,
        [target],
        tokens,
        nameOnlyDefs
      );
      
      assert.strictEqual(
        result,
        undefined,
        'Should not auto-resolve when Name does not match pattern and Extends is disabled'
      );
    });
    
    test('respects injectionmatchpaths order', () => {
      const tokens = new Map([
        ['appname', 'BaseApp'],
        ['entity', 'Field']
      ]);
      
      const nameMatch = createDataStoreTarget('BaseApp.Field', {
        Name: 'BaseApp'
      });
      
      const extendsMatch = createDataStoreTarget('BaseApp.Field', {
        Extends: 'BaseApp',
        Name: 'SomeExtension'
      });
      
      const sectionPattern = "Table[@EntityDefName='{appname}.{entity}']";
      
      // Test with Name first
      let result = testSmartInjectionWithPattern(
        'DataStore',
        sectionPattern,
        [extendsMatch, nameMatch],
        tokens,
        tokenDefs
      );
      
      assert.strictEqual(result, nameMatch, 'Should prefer Name when configured first');
      
      // Test with Extends first
      const extendsFirstDefs = [{
        ...tokenDefs[0],
        tokenReadPaths: {
          appname: {
            ...tokenDefs[0].tokenReadPaths.appname,
            injectionmatchpaths: ['App/@Extends', 'App/@Name']  // Reversed order!
          },
          entity: tokenDefs[0].tokenReadPaths.entity
        }
      }];
      
      result = testSmartInjectionWithPattern(
        'DataStore',
        sectionPattern,
        [extendsMatch, nameMatch],
        tokens,
        extendsFirstDefs
      );
      
      assert.strictEqual(result, extendsMatch, 'Should prefer Extends when configured first');
    });
    
    test('handles wildcard injectionmatchpaths with pattern', () => {
      const tokens = new Map([
        ['appname', 'kahua_AEC_RFI'],
        ['entity', 'Field']
      ]);
      
      const target = createDataStoreTarget('kahua_AEC_RFI.Field', {
        Name: 'SomeExtension',
        Extends: 'kahua_AEC_RFI',
        SomeOtherAttr: 'kahua_AEC_RFI'
      });
      
      const sectionPattern = "Table[@EntityDefName='{appname}.{entity}']";
      
      const wildcardDefs = [{
        ...tokenDefs[0],
        tokenReadPaths: {
          appname: {
            ...tokenDefs[0].tokenReadPaths.appname,
            injectionmatchpaths: ['App/@*']  // Match ANY attribute
          },
          entity: tokenDefs[0].tokenReadPaths.entity
        }
      }];
      
      const result = testSmartInjectionWithPattern(
        'DataStore',
        sectionPattern,
        [target],
        tokens,
        wildcardDefs
      );
      
      assert.strictEqual(result, target, 'Should match via wildcard when any attribute matches pattern');
    });
  });
  
  suite('Attributes Section (no multi-token pattern)', () => {
    
    const tokenDefs = [{
      id: 'smart',
      name: 'Smart Tokens',
      type: 'header',
      tokens: 'appname,entity',
      tokenReadPaths: {
        appname: {
          type: 'attribute',
          readpaths: ['App/@Name'],
          injectionmatchpaths: ['App/@Name', 'App/@Extends'],
          affectsInjection: true
        },
        entity: {
          type: 'selection',
          readpaths: ['App/EntityDefs/EntityDef'],
          attribute: 'Name',
          affectsInjection: true,
          injectionPathTemplate: 'App/EntityDefs/EntityDef[@Name=\'{value}\']/Attributes'
        }
      }
    }];
    
    test('matches using entity template without appname pattern', () => {
      const tokens = new Map([
        ['appname', 'BaseApp'],
        ['entity', 'Field']
      ]);
      
      const target = createAttributesTarget('Field', {
        Name: 'BaseApp'
      });
      
      // No section pattern needed for Attributes (entity template handles it)
      const result = testSmartInjectionWithPattern(
        'Attributes',
        undefined,
        [target],
        tokens,
        tokenDefs
      );
      
      assert.strictEqual(result, target, 'Should match using entity template');
    });
    
    test('respects appname injectionmatchpaths even without section pattern', () => {
      const tokens = new Map([
        ['appname', 'BaseApp'],
        ['entity', 'Field']
      ]);
      
      const nameMatch = createAttributesTarget('Field', {
        Name: 'BaseApp'
      });
      
      const extendsMatch = createAttributesTarget('Field', {
        Name: 'Extension',
        Extends: 'BaseApp'
      });
      
      let result = testSmartInjectionWithPattern(
        'Attributes',
        undefined,
        [extendsMatch, nameMatch],
        tokens,
        tokenDefs
      );
      
      assert.strictEqual(result, nameMatch, 'Should prefer Name match');
      
      // Test with Extends first
      const extendsFirstDefs = [{
        ...tokenDefs[0],
        tokenReadPaths: {
          appname: {
            ...tokenDefs[0].tokenReadPaths.appname,
            injectionmatchpaths: ['App/@Extends', 'App/@Name']
          },
          entity: tokenDefs[0].tokenReadPaths.entity
        }
      }];
      
      result = testSmartInjectionWithPattern(
        'Attributes',
        undefined,
        [extendsMatch, nameMatch],
        tokens,
        extendsFirstDefs
      );
      
      assert.strictEqual(result, extendsMatch, 'Should prefer Extends when configured first');
    });
  });
  
  suite('Pattern with Missing Tokens', () => {
    
    test('does not validate pattern when tokens are incomplete', () => {
      const tokens = new Map([
        // appname missing!
        ['entity', 'RFI']
      ]);
      
      const target = createDataStoreTarget('kahua_AEC_RFI.RFI', {
        Name: 'kahua_AEC_RFI'
      });
      
      const sectionPattern = "Table[@EntityDefName='{appname}.{entity}']";
      
      const result = testSmartInjectionWithPattern(
        'DataStore',
        sectionPattern,
        [target],
        tokens,
        []
      );
      
      assert.strictEqual(
        result,
        undefined,
        'Should not validate or match when required tokens are missing'
      );
    });
  });
});

// Helper functions

function createDataStoreTarget(entityDefName: string, appAttrs?: any): any {
  const appElement: any = {
    tagName: 'App',
    attributes: { ...(appAttrs || {}) },
    parent: undefined
  };
  
  const tableElement: any = {
    tagName: 'Table',
    attributes: { EntityDefName: entityDefName },
    parent: appElement
  };
  
  return {
    tagName: 'DataStore',
    injectionPath: `App/DataStore/Tables/Table[@EntityDefName="${entityDefName}"]/Columns`,
    attributes: { EntityDefName: entityDefName },
    element: tableElement,
    context: `Table(${entityDefName})/Columns`
  };
}

function createAttributesTarget(entityName: string, appAttrs?: any): any {
  const appElement: any = {
    tagName: 'App',
    attributes: { ...(appAttrs || {}) },
    parent: undefined
  };
  
  const entityElement: any = {
    tagName: 'EntityDef',
    attributes: { Name: entityName },
    parent: appElement
  };
  
  return {
    tagName: 'Attributes',
    injectionPath: `App/EntityDefs/EntityDef[@Name="${entityName}"]/Attributes`,
    attributes: { Name: entityName },
    element: entityElement,
    context: `EntityDef(${entityName})/Attributes`
  };
}

// Mock for enhanced test function (needs to be implemented in extension.ts)
function __testSmartInjectionWithPattern(
  sectionName: string,
  sectionPattern: string | undefined,
  targets: any[],
  tokens: Map<string, string>,
  tokenDefinitions: any[]
): any | undefined {
  // TODO: This needs to be implemented in extension.ts and exported
  // For now, this is a placeholder showing what the signature should be
  
  // The implementation should:
  // 1. Validate that targets match the section pattern (if provided)
  // 2. Only consider targets that pass pattern validation
  // 3. Apply smart injection resolution to the filtered targets
  
  return undefined;
}
