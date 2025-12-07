/**
 * Split Responsibility Tests (Option C)
 * Separates concerns: target collection vs. smart selection
 */

import * as assert from 'assert';
import { __testSmartInjectionResolution } from '../../extension';

suite('Split Responsibility Tests', () => {
  
  suite('Part 1: Target Collection (Path Pattern Matching)', () => {
    
    test('pattern matches when all tokens are present', () => {
      const pattern = "Table[@EntityDefName='{appname}.{entity}']";
      const tokens = new Map([
        ['appname', 'kahua_AEC_RFI'],
        ['entity', 'RFI']
      ]);
      const targetPath = "Table[@EntityDefName='kahua_AEC_RFI.RFI']";
      
      const matches = patternMatchesPath(pattern, tokens, targetPath);
      
      assert.strictEqual(matches, true, 'Pattern should match when all tokens align');
    });
    
    test('pattern does not match when token value differs', () => {
      const pattern = "Table[@EntityDefName='{appname}.{entity}']";
      const tokens = new Map([
        ['appname', 'kahua_aec_rfi_extension'],
        ['entity', 'RFI']
      ]);
      const targetPath = "Table[@EntityDefName='kahua_AEC_RFI.RFI']";
      
      const matches = patternMatchesPath(pattern, tokens, targetPath);
      
      assert.strictEqual(matches, false, 'Pattern should not match when token values differ');
    });
    
    test('pattern matches with multiple token occurrences', () => {
      const pattern = "HubDef[@Name='{hubname}']/LogDef[@Name='{hubname}.{entity}']";
      const tokens = new Map([
        ['hubname', 'MyHub'],
        ['entity', 'RFI']
      ]);
      const targetPath = "HubDef[@Name='MyHub']/LogDef[@Name='MyHub.RFI']";
      
      const matches = patternMatchesPath(pattern, tokens, targetPath);
      
      assert.strictEqual(matches, true, 'Should match when same token appears multiple times');
    });
    
    test('pattern matching is case-sensitive', () => {
      const pattern = "Table[@EntityDefName='{appname}.{entity}']";
      const tokens = new Map([
        ['appname', 'kahua_aec_rfi'],  // lowercase
        ['entity', 'RFI']
      ]);
      const targetPath = "Table[@EntityDefName='kahua_AEC_RFI.RFI']";  // uppercase
      
      const matches = patternMatchesPath(pattern, tokens, targetPath);
      
      assert.strictEqual(matches, false, 'Pattern matching should be case-sensitive');
    });
    
    test('filters targets based on pattern', () => {
      const allTargets = [
        { injectionPath: "Table[@EntityDefName='kahua_AEC_RFI.RFI']/Columns" },
        { injectionPath: "Table[@EntityDefName='kahua_AEC_RFI.Other']/Columns" },
        { injectionPath: "Table[@EntityDefName='DifferentApp.Field']/Columns" }
      ];
      
      const pattern = "Table[@EntityDefName='{appname}.{entity}']";
      const tokens = new Map([
        ['appname', 'kahua_AEC_RFI'],
        ['entity', 'RFI']
      ]);
      
      const filtered = filterTargetsByPattern(allTargets, pattern, tokens);
      
      assert.strictEqual(filtered.length, 1, 'Should filter to only matching target');
      assert.ok(
        filtered[0].injectionPath.includes('.RFI'),
        'Should keep the RFI target'
      );
    });
    
    test('handles targets with no pattern (all pass through)', () => {
      const allTargets = [
        { injectionPath: "App/DataTags" },
        { injectionPath: "App/DataTags" }
      ];
      
      const pattern = undefined;  // No pattern
      const tokens = new Map();
      
      const filtered = filterTargetsByPattern(allTargets, pattern, tokens);
      
      assert.strictEqual(filtered.length, 2, 'Should pass through all targets when no pattern');
    });
    
    test('handles empty targets list', () => {
      const allTargets: any[] = [];
      const pattern = "Table[@EntityDefName='{appname}.{entity}']";
      const tokens = new Map([
        ['appname', 'kahua_AEC_RFI'],
        ['entity', 'RFI']
      ]);
      
      const filtered = filterTargetsByPattern(allTargets, pattern, tokens);
      
      assert.strictEqual(filtered.length, 0, 'Should return empty array for empty input');
    });
  });
  
  suite('Part 2: Smart Selection (Choosing Best Target)', () => {
    
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
    
    test('auto-selects when only one target matches', () => {
      const tokens = new Map([
        ['appname', 'BaseApp'],
        ['entity', 'Field']
      ]);
      
      const target = createSimpleTarget('EntityDef[@Name="Field"]/Attributes', {
        Name: 'BaseApp'
      });
      
      const result = __testSmartInjectionResolution(
        'Attributes',
        [target],
        tokens,
        tokenDefs
      );
      
      assert.strictEqual(result, target, 'Should auto-select single matching target');
    });
    
    test('returns undefined when no targets provided', () => {
      const tokens = new Map([
        ['appname', 'BaseApp'],
        ['entity', 'Field']
      ]);
      
      const result = __testSmartInjectionResolution(
        'Attributes',
        [],
        tokens,
        tokenDefs
      );
      
      assert.strictEqual(result, undefined, 'Should return undefined for empty targets');
    });
    
    test('prefers Name match over Extends match when both present', () => {
      const tokens = new Map([
        ['appname', 'BaseApp'],
        ['entity', 'Field']
      ]);
      
      const nameTarget = createSimpleTarget('EntityDef[@Name="Field"]/Attributes', {
        Name: 'BaseApp'
      });
      
      const extendsTarget = createSimpleTarget('EntityDef[@Name="Field"]/Attributes', {
        Name: 'Extension',
        Extends: 'BaseApp'
      });
      
      // With Name first in injectionmatchpaths
      const result = __testSmartInjectionResolution(
        'Attributes',
        [extendsTarget, nameTarget],  // Order shouldn't matter
        tokens,
        tokenDefs
      );
      
      assert.strictEqual(result, nameTarget, 'Should prefer Name match when configured first');
    });
    
    test('uses Extends match when Name is not configured', () => {
      const tokens = new Map([
        ['appname', 'BaseApp'],
        ['entity', 'Field']
      ]);
      
      const extendsTarget = createSimpleTarget('EntityDef[@Name="Field"]/Attributes', {
        Name: 'Extension',
        Extends: 'BaseApp'
      });
      
      const extendsOnlyDefs = [{
        ...tokenDefs[0],
        tokenReadPaths: {
          appname: {
            ...tokenDefs[0].tokenReadPaths.appname,
            injectionmatchpaths: ['App/@Extends']  // Only Extends!
          },
          entity: tokenDefs[0].tokenReadPaths.entity
        }
      }];
      
      const result = __testSmartInjectionResolution(
        'Attributes',
        [extendsTarget],
        tokens,
        extendsOnlyDefs
      );
      
      assert.strictEqual(result, extendsTarget, 'Should match via Extends when configured');
    });
    
    test('returns undefined when token does not match any target', () => {
      const tokens = new Map([
        ['appname', 'WrongApp'],
        ['entity', 'Field']
      ]);
      
      const target = createSimpleTarget('EntityDef[@Name="Field"]/Attributes', {
        Name: 'CorrectApp'
      });
      
      const result = __testSmartInjectionResolution(
        'Attributes',
        [target],
        tokens,
        tokenDefs
      );
      
      assert.strictEqual(result, undefined, 'Should not match when appname differs');
    });
    
    test('handles wildcard injectionmatchpaths', () => {
      const tokens = new Map([
        ['appname', 'BaseApp'],
        ['entity', 'Field']
      ]);
      
      const target = createSimpleTarget('EntityDef[@Name="Field"]/Attributes', {
        SomeCustomAttr: 'BaseApp',
        Name: 'DifferentName'
      });
      
      const wildcardDefs = [{
        ...tokenDefs[0],
        tokenReadPaths: {
          appname: {
            ...tokenDefs[0].tokenReadPaths.appname,
            injectionmatchpaths: ['App/@*']  // ANY attribute
          },
          entity: tokenDefs[0].tokenReadPaths.entity
        }
      }];
      
      const result = __testSmartInjectionResolution(
        'Attributes',
        [target],
        tokens,
        wildcardDefs
      );
      
      assert.strictEqual(result, target, 'Should match via wildcard when any attribute matches');
    });
    
    test('returns undefined for multiple targets (requires user selection)', () => {
      const tokens = new Map([
        ['appname', 'BaseApp'],
        ['entity', 'Field']
      ]);
      
      const target1 = createSimpleTarget('EntityDef[@Name="Field"]/Attributes', {
        Name: 'BaseApp'
      });
      
      const target2 = createSimpleTarget('EntityDef[@Name="Field"]/Attributes', {
        Name: 'BaseApp'
      });
      
      const result = __testSmartInjectionResolution(
        'Attributes',
        [target1, target2],
        tokens,
        tokenDefs
      );
      
      // When multiple targets match exactly, smart injection should return undefined
      // to trigger user selection in production
      assert.strictEqual(
        result,
        undefined,
        'Should return undefined when multiple targets match (ambiguous)'
      );
    });
  });
  
  suite('Integration: Target Collection + Smart Selection', () => {
    
    test('full flow: collect by pattern, then smart select', () => {
      // Step 1: Start with all possible targets (before pattern filtering)
      const allTargets = [
        createDataStoreTarget('kahua_AEC_RFI.RFI', 'kahua_AEC_RFI', undefined),
        createDataStoreTarget('kahua_AEC_RFI.Other', 'kahua_AEC_RFI', undefined),
        createDataStoreTarget('DifferentApp.Field', 'DifferentApp', undefined)
      ];
      
      const sectionPattern = "Table[@EntityDefName='{appname}.{entity}']";
      const tokens = new Map([
        ['appname', 'kahua_AEC_RFI'],
        ['entity', 'RFI']
      ]);
      
      // Step 2: Filter by pattern (simulates target collection)
      const filteredTargets = filterTargetsByPattern(allTargets, sectionPattern, tokens);
      
      assert.strictEqual(filteredTargets.length, 1, 'Pattern filtering should find 1 target');
      
      // Step 3: Smart selection (should auto-select the single target)
      const tokenDefs = [{
        id: 'smart',
        tokenReadPaths: {
          appname: {
            injectionmatchpaths: ['App/@Name', 'App/@Extends'],
            affectsInjection: true
          },
          entity: {
            affectsInjection: true
          }
        }
      }];
      
      const selected = __testSmartInjectionResolution(
        'DataStore',
        filteredTargets,
        tokens,
        tokenDefs
      );
      
      assert.strictEqual(selected, filteredTargets[0], 'Should auto-select the filtered target');
    });
    
    test('full flow with fallback: Name fails pattern, Extends succeeds', () => {
      // All targets (before filtering)
      const allTargets = [
        createDataStoreTarget('kahua_AEC_RFI.RFI', 'kahua_aec_rfi_extension', 'kahua_AEC_RFI'),
        createDataStoreTarget('kahua_AEC_RFI.Other', 'kahua_AEC_RFI', undefined)
      ];
      
      const sectionPattern = "Table[@EntityDefName='{appname}.{entity}']";
      
      // Try with Name value first
      let tokens = new Map([
        ['appname', 'kahua_aec_rfi_extension'],
        ['entity', 'RFI']
      ]);
      
      let filtered = filterTargetsByPattern(allTargets, sectionPattern, tokens);
      
      assert.strictEqual(filtered.length, 0, 'Name value should not match any pattern');
      
      // Fallback to Extends value
      tokens = new Map([
        ['appname', 'kahua_AEC_RFI'],
        ['entity', 'RFI']
      ]);
      
      filtered = filterTargetsByPattern(allTargets, sectionPattern, tokens);
      
      assert.strictEqual(filtered.length, 1, 'Extends value should match pattern');
      assert.ok(
        filtered[0].injectionPath.includes('.RFI'),
        'Should find the RFI target'
      );
    });
  });
});

// Helper Functions

function patternMatchesPath(
  pattern: string,
  tokens: Map<string, string>,
  targetPath: string
): boolean {
  // Resolve pattern with token values
  let resolvedPattern = pattern;
  for (const [tokenName, tokenValue] of tokens.entries()) {
    resolvedPattern = resolvedPattern.replace(new RegExp(`\\{${tokenName}\\}`, 'g'), tokenValue);
  }
  
  // Check if resolved pattern matches target path
  return targetPath.includes(resolvedPattern.match(/@\w+='([^']+)'/)?.[1] || '');
}

function filterTargetsByPattern(
  targets: any[],
  pattern: string | undefined,
  tokens: Map<string, string>
): any[] {
  if (!pattern) {
    return targets;  // No filtering when no pattern
  }
  
  return targets.filter(target => {
    return patternMatchesPath(pattern, tokens, target.injectionPath);
  });
}

function createSimpleTarget(path: string, appAttrs?: any): any {
  const appElement: any = {
    tagName: 'App',
    attributes: { ...(appAttrs || {}) },
    parent: undefined
  };
  
  return {
    injectionPath: `App/${path}`,
    element: appElement,
    attributes: {}
  };
}

function createDataStoreTarget(entityDefName: string, appName?: string, appExtends?: string): any {
  const appElement: any = {
    tagName: 'App',
    attributes: {},
    parent: undefined
  };
  
  if (appName) appElement.attributes.Name = appName;
  if (appExtends) appElement.attributes.Extends = appExtends;
  
  return {
    injectionPath: `App/DataStore/Tables/Table[@EntityDefName="${entityDefName}"]/Columns`,
    element: appElement,
    attributes: { EntityDefName: entityDefName },
    context: `Table(${entityDefName})/Columns`
  };
}
