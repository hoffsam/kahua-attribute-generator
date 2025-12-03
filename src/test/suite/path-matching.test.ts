import * as assert from 'assert';
import * as vscode from 'vscode';
import { applyInjectionPathTemplate } from '../../extension';

interface TokenNameDefinition {
  id: string;
  name: string;
  type: 'header' | 'table';
  tokens: string;
  tokenReadPaths?: Record<string, TokenReadPath>;
}

interface TokenReadPath {
  type: 'extraction' | 'selection';
  path: string;
  attribute?: string;
  affectsInjection?: boolean;
  injectionPathTemplate?: string;
}

function createTokenDef(id: string, name: string, type: 'header' | 'table', tokens: string, tokenReadPaths?: Record<string, TokenReadPath>): TokenNameDefinition {
  return { id, name, type, tokens, tokenReadPaths };
}

suite('Path Matching Tests', () => {
  
  suite('HubDef Path Matching', () => {
    
    test('Should match HubDef paths with attribute filters', () => {
      const xpath = '/App/App.HubDefs/HubDef[@Name=\'ExtendedWorkflow\']/HubDef.Logs/Logs/Log.Fields';
      const affectingTokens = new Map([['entity', 'ExtendedWorkflow']]);
      const tokenDefinitions: TokenNameDefinition[] = [
        createTokenDef('hubdef-entity', 'HubDef Entity Token', 'header', 'entity', {
          entity: {
            type: 'selection',
            path: 'App/App.HubDefs/HubDef',
            attribute: 'Name',
            affectsInjection: true,
            injectionPathTemplate: 'App/App.HubDefs/HubDef[@Name=\'{entity}\']/HubDef.Logs/Logs/Log.Fields'
          }
        })
      ];
      
      const result = applyInjectionPathTemplate(xpath, affectingTokens, tokenDefinitions);
      
      assert.strictEqual(result.success, true, 'Should succeed in applying template');
      assert.strictEqual(result.result, '/App/App.HubDefs/HubDef[@Name=\'ExtendedWorkflow\']/HubDef.Logs/Logs/Log.Fields');
    });

    test('Should match HubDef FieldDefs paths', () => {
      const xpath = '/App/App.HubDefs/HubDef[@Name=\'ExtendedWorkflow\']/HubDef.LogDef/LogDef.FieldDefs';
      const affectingTokens = new Map([['entity', 'ExtendedWorkflow']]);
      const tokenDefinitions: TokenNameDefinition[] = [{
        id: 'hubdef-entity',
        type: 'header', 
        tokens: 'entity',
        tokenReadPaths: {
          entity: {
            type: 'selection',
            path: 'App/App.HubDefs/HubDef',
            attribute: 'Name',
            affectsInjection: true,
            injectionPathTemplate: 'App/App.HubDefs/HubDef[@Name=\'{entity}\']/HubDef.LogDef/LogDef.FieldDefs'
          }
        }
      }];
      
      const result = applyInjectionPathTemplate(xpath, affectingTokens, tokenDefinitions);
      
      assert.strictEqual(result.success, true, 'Should succeed in applying template');
      assert.strictEqual(result.result, '/App/App.HubDefs/HubDef[@Name=\'ExtendedWorkflow\']/HubDef.LogDef/LogDef.FieldDefs');
    });

    test('Should not match non-HubDef paths with HubDef templates', () => {
      const xpath = '/App/DataStore/Tables/Table/Columns';
      const affectingTokens = new Map([['entity', 'ExtendedWorkflow']]);
      const tokenDefinitions: TokenNameDefinition[] = [{
        id: 'hubdef-entity',
        type: 'header',
        tokens: 'entity', 
        tokenReadPaths: {
          entity: {
            type: 'selection',
            path: 'App/App.HubDefs/HubDef',
            attribute: 'Name',
            affectsInjection: true,
            injectionPathTemplate: 'App/App.HubDefs/HubDef[@Name=\'{entity}\']/HubDef.Logs/Logs/Log.Fields'
          }
        }
      }];
      
      const result = applyInjectionPathTemplate(xpath, affectingTokens, tokenDefinitions);
      
      // Should return success but original path unchanged (no template applied)
      assert.strictEqual(result.success, true, 'Should succeed but not apply template');
      assert.strictEqual(result.result, xpath, 'Should return original path unchanged');
    });

    test('Should handle HubDef paths with different entity values', () => {
      const xpath = '/App/App.HubDefs/HubDef[@Name=\'MyCustomWorkflow\']/HubDef.Logs/Logs/Log.Fields';
      const affectingTokens = new Map([['entity', 'MyCustomWorkflow']]);
      const tokenDefinitions: TokenNameDefinition[] = [{
        id: 'hubdef-entity',
        type: 'header',
        tokens: 'entity',
        tokenReadPaths: {
          entity: {
            type: 'selection', 
            path: 'App/App.HubDefs/HubDef',
            attribute: 'Name',
            affectsInjection: true,
            injectionPathTemplate: 'App/App.HubDefs/HubDef[@Name=\'{entity}\']/HubDef.Logs/Logs/Log.Fields'
          }
        }
      }];
      
      const result = applyInjectionPathTemplate(xpath, affectingTokens, tokenDefinitions);
      
      assert.strictEqual(result.success, true, 'Should succeed');
      assert.strictEqual(result.result, '/App/App.HubDefs/HubDef[@Name=\'MyCustomWorkflow\']/HubDef.Logs/Logs/Log.Fields');
    });
  });

  suite('EntityDef Path Matching (Regression Tests)', () => {
    
    test('Should still match EntityDef paths correctly', () => {
      const xpath = '/App/EntityDefs/EntityDef[@Name=\'Field\']/Attributes';
      const affectingTokens = new Map([['entity', 'Field']]);
      const tokenDefinitions: TokenNameDefinition[] = [{
        id: 'entity-def',
        type: 'header',
        tokens: 'entity',
        tokenReadPaths: {
          entity: {
            type: 'selection',
            path: 'EntityDefs/EntityDef', 
            attribute: 'Name',
            affectsInjection: true,
            injectionPathTemplate: '/App/EntityDefs/EntityDef[@Name=\'{entity}\']/Attributes'
          }
        }
      }];
      
      const result = applyInjectionPathTemplate(xpath, affectingTokens, tokenDefinitions);
      
      assert.strictEqual(result.success, true, 'Should succeed');
      assert.strictEqual(result.result, '/App/EntityDefs/EntityDef[@Name=\'Field\']/Attributes');
    });

    test('Should match relative EntityDef paths', () => {
      const xpath = 'EntityDefs/EntityDef/Attributes';
      const affectingTokens = new Map([['entity', 'RFI']]);
      const tokenDefinitions: TokenNameDefinition[] = [{
        id: 'entity-def',
        type: 'header',
        tokens: 'entity',
        tokenReadPaths: {
          entity: {
            type: 'selection',
            path: 'EntityDefs/EntityDef',
            attribute: 'Name', 
            affectsInjection: true,
            injectionPathTemplate: 'EntityDefs/EntityDef[@Name=\'{entity}\']/Attributes'
          }
        }
      }];
      
      const result = applyInjectionPathTemplate(xpath, affectingTokens, tokenDefinitions);
      
      assert.strictEqual(result.success, true, 'Should succeed');
      assert.strictEqual(result.result, 'EntityDefs/EntityDef[@Name=\'RFI\']/Attributes');
    });
  });

  suite('DataStore Path Matching (Regression Tests)', () => {
    
    test('Should still match DataStore Table paths correctly', () => {
      const xpath = '/App/DataStore/Tables/Table/Columns';
      const affectingTokens = new Map([['entity', 'RFI']]);
      const tokenDefinitions: TokenNameDefinition[] = [{
        id: 'datastore-entity',
        type: 'header',
        tokens: 'entity',
        tokenReadPaths: {
          entity: {
            type: 'selection',
            path: 'DataStore/Tables/Table',
            attribute: 'EntityDefName',
            affectsInjection: true,
            injectionPathTemplate: '/App/DataStore/Tables/Table[@EntityDefName=\'{entity}\']/Columns'
          }
        }
      }];
      
      const result = applyInjectionPathTemplate(xpath, affectingTokens, tokenDefinitions);
      
      assert.strictEqual(result.success, true, 'Should succeed');
      assert.strictEqual(result.result, '/App/DataStore/Tables/Table[@EntityDefName=\'RFI\']/Columns');
    });

    test('Should match DataStore Labels paths', () => {
      const xpath = 'DataStore/Tables/Table/Labels';
      const affectingTokens = new Map([['entity', 'Field']]);
      const tokenDefinitions: TokenNameDefinition[] = [{
        id: 'datastore-entity',
        type: 'header',
        tokens: 'entity',
        tokenReadPaths: {
          entity: {
            type: 'selection',
            path: 'DataStore/Tables/Table',
            attribute: 'EntityDefName',
            affectsInjection: true,
            injectionPathTemplate: 'DataStore/Tables/Table[@EntityDefName=\'{entity}\']/Labels'
          }
        }
      }];
      
      const result = applyInjectionPathTemplate(xpath, affectingTokens, tokenDefinitions);
      
      assert.strictEqual(result.success, true, 'Should succeed');
      assert.strictEqual(result.result, 'DataStore/Tables/Table[@EntityDefName=\'Field\']/Labels');
    });
  });

  suite('General Token Substitution (Regression Tests)', () => {
    
    test('Should handle general {token} replacement in paths', () => {
      const xpath = '/App/EntityDefs/EntityDef[@Name=\'{entity}\']/Attributes';
      const affectingTokens = new Map([['entity', 'CustomEntity']]);
      const tokenDefinitions: TokenNameDefinition[] = [];
      
      const result = applyInjectionPathTemplate(xpath, affectingTokens, tokenDefinitions);
      
      assert.strictEqual(result.success, true, 'Should succeed');
      assert.strictEqual(result.result, '/App/EntityDefs/EntityDef[@Name=\'CustomEntity\']/Attributes');
    });

    test('Should handle multiple token substitutions', () => {
      const xpath = '/App/{appname}/EntityDefs/EntityDef[@Name=\'{entity}\']/Attributes';
      const affectingTokens = new Map([
        ['entity', 'RFI'],
        ['appname', 'MyApplication']
      ]);
      const tokenDefinitions: TokenNameDefinition[] = [];
      
      const result = applyInjectionPathTemplate(xpath, affectingTokens, tokenDefinitions);
      
      assert.strictEqual(result.success, true, 'Should succeed');
      assert.strictEqual(result.result, '/App/MyApplication/EntityDefs/EntityDef[@Name=\'RFI\']/Attributes');
    });

    test('Should handle paths with no tokens (pass through)', () => {
      const xpath = '/App/EntityDefs/EntityDef/Attributes';
      const affectingTokens = new Map([['entity', 'Field']]);
      const tokenDefinitions: TokenNameDefinition[] = [];
      
      const result = applyInjectionPathTemplate(xpath, affectingTokens, tokenDefinitions);
      
      assert.strictEqual(result.success, true, 'Should succeed');
      assert.strictEqual(result.result, xpath, 'Should return original path unchanged');
    });
  });

  suite('Edge Cases', () => {
    
    test('Should handle empty affecting tokens', () => {
      const xpath = '/App/EntityDefs/EntityDef/Attributes';
      const affectingTokens = new Map<string, string>();
      const tokenDefinitions: TokenNameDefinition[] = [];
      
      const result = applyInjectionPathTemplate(xpath, affectingTokens, tokenDefinitions);
      
      assert.strictEqual(result.success, true, 'Should succeed');
      assert.strictEqual(result.result, xpath, 'Should return original path unchanged');
    });

    test('Should handle malformed template paths gracefully', () => {
      const xpath = '/App/HubDefs/HubDef[@Name=\'Test\']/Something';
      const affectingTokens = new Map([['entity', 'Test']]);
      const tokenDefinitions: TokenNameDefinition[] = [{
        id: 'broken-template',
        type: 'header',
        tokens: 'entity',
        tokenReadPaths: {
          entity: {
            type: 'selection',
            path: 'HubDefs/HubDef',
            attribute: 'Name',
            affectsInjection: true,
            injectionPathTemplate: 'HubDefs/HubDef[@Name={entity}]/Something' // Missing quotes around {entity}
          }
        }
      }];
      
      const result = applyInjectionPathTemplate(xpath, affectingTokens, tokenDefinitions);
      
      // Should still succeed and at least apply general token substitution
      assert.strictEqual(result.success, true, 'Should succeed even with malformed template');
    });

    test('Should handle case sensitivity in path matching', () => {
      const xpath = '/App/App.HubDefs/hubdef[@Name=\'Test\']/Something'; // lowercase 'hubdef'
      const affectingTokens = new Map([['entity', 'Test']]);
      const tokenDefinitions: TokenNameDefinition[] = [{
        id: 'case-test',
        type: 'header', 
        tokens: 'entity',
        tokenReadPaths: {
          entity: {
            type: 'selection',
            path: 'App/App.HubDefs/HubDef', // uppercase 'HubDef'
            attribute: 'Name',
            affectsInjection: true,
            injectionPathTemplate: 'App/App.HubDefs/HubDef[@Name=\'{entity}\']/Something'
          }
        }
      }];
      
      const result = applyInjectionPathTemplate(xpath, affectingTokens, tokenDefinitions);
      
      // Should not match due to case difference and return original path
      assert.strictEqual(result.success, true, 'Should succeed');
      assert.strictEqual(result.result, xpath, 'Should return original path due to case mismatch');
    });
  });

  suite('Complex HubDef Scenarios', () => {
    
    test('Should handle nested HubDef structures', () => {
      const xpath = '/App/App.HubDefs/HubDef[@Name=\'WorkflowHub\']/HubDef.SubHubs/SubHub/HubDef.Logs/Logs/Log.Fields';
      const affectingTokens = new Map([['entity', 'WorkflowHub']]);
      const tokenDefinitions: TokenNameDefinition[] = [{
        id: 'nested-hubdef',
        type: 'header',
        tokens: 'entity',
        tokenReadPaths: {
          entity: {
            type: 'selection',
            path: 'App/App.HubDefs/HubDef',
            attribute: 'Name',
            affectsInjection: true,
            injectionPathTemplate: 'App/App.HubDefs/HubDef[@Name=\'{entity}\']/HubDef.SubHubs/SubHub/HubDef.Logs/Logs/Log.Fields'
          }
        }
      }];
      
      const result = applyInjectionPathTemplate(xpath, affectingTokens, tokenDefinitions);
      
      assert.strictEqual(result.success, true, 'Should succeed');
      assert.strictEqual(result.result, '/App/App.HubDefs/HubDef[@Name=\'WorkflowHub\']/HubDef.SubHubs/SubHub/HubDef.Logs/Logs/Log.Fields');
    });

    test('Should handle HubDef paths with multiple attributes', () => {
      const xpath = '/App/App.HubDefs/HubDef[@Name=\'Test\' and @Type=\'Workflow\']/HubDef.Logs/Logs/Log.Fields';
      const affectingTokens = new Map([['entity', 'Test']]);
      const tokenDefinitions: TokenNameDefinition[] = [{
        id: 'multi-attr-hubdef',
        type: 'header',
        tokens: 'entity', 
        tokenReadPaths: {
          entity: {
            type: 'selection',
            path: 'App/App.HubDefs/HubDef',
            attribute: 'Name',
            affectsInjection: true,
            injectionPathTemplate: 'App/App.HubDefs/HubDef[@Name=\'{entity}\' and @Type=\'Workflow\']/HubDef.Logs/Logs/Log.Fields'
          }
        }
      }];
      
      const result = applyInjectionPathTemplate(xpath, affectingTokens, tokenDefinitions);
      
      assert.strictEqual(result.success, true, 'Should succeed');
      assert.strictEqual(result.result, '/App/App.HubDefs/HubDef[@Name=\'Test\' and @Type=\'Workflow\']/HubDef.Logs/Logs/Log.Fields');
    });
  });
});