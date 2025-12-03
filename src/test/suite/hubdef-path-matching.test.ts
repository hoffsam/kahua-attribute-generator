import * as assert from 'assert';
import { applyInjectionPathTemplate } from '../../extension';

// Mock the TokenNameDefinition type for tests
interface TestTokenNameDefinition {
  id: string;
  name: string;
  type: 'header' | 'table';
  tokens: string;
  tokenReadPaths?: Record<string, TestTokenReadPath>;
}

interface TestTokenReadPath {
  type: 'extraction' | 'selection';
  path: string;
  attribute?: string;
  affectsInjection?: boolean;
  injectionPathTemplate?: string;
}

suite('HubDef Path Matching Fix Tests', () => {
  
  test('Should match HubDef LogFields path with entity attribute', () => {
    const xpath = '/App/App.HubDefs/HubDef[@Name=\'ExtendedWorkflow\']/HubDef.Logs/Logs/Log.Fields';
    const affectingTokens = new Map([['entity', 'ExtendedWorkflow']]);
    const tokenDefinitions: TestTokenNameDefinition[] = [{
      id: 'hubdef-entity',
      name: 'HubDef Entity Token',
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
    
    const result = applyInjectionPathTemplate(xpath, affectingTokens, tokenDefinitions as any);
    
    assert.strictEqual(result.success, true, 'Should successfully apply template');
    assert.strictEqual(result.result, '/App/App.HubDefs/HubDef[@Name=\'ExtendedWorkflow\']/HubDef.Logs/Logs/Log.Fields');
  });

  test('Should match HubDef FieldDefs path with entity attribute', () => {
    const xpath = '/App/App.HubDefs/HubDef[@Name=\'ExtendedWorkflow\']/HubDef.LogDef/LogDef.FieldDefs';
    const affectingTokens = new Map([['entity', 'ExtendedWorkflow']]);
    const tokenDefinitions: TestTokenNameDefinition[] = [{
      id: 'hubdef-entity',
      name: 'HubDef Entity Token', 
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
    
    const result = applyInjectionPathTemplate(xpath, affectingTokens, tokenDefinitions as any);
    
    assert.strictEqual(result.success, true, 'Should successfully apply template');
    assert.strictEqual(result.result, '/App/App.HubDefs/HubDef[@Name=\'ExtendedWorkflow\']/HubDef.LogDef/LogDef.FieldDefs');
  });

  test('Should work with different entity values', () => {
    const xpath = '/App/App.HubDefs/HubDef[@Name=\'MyCustomHub\']/HubDef.Logs/Logs/Log.Fields';
    const affectingTokens = new Map([['entity', 'MyCustomHub']]);
    const tokenDefinitions: TestTokenNameDefinition[] = [{
      id: 'hubdef-entity',
      name: 'HubDef Entity Token',
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
    
    const result = applyInjectionPathTemplate(xpath, affectingTokens, tokenDefinitions as any);
    
    assert.strictEqual(result.success, true, 'Should successfully apply template');
    assert.strictEqual(result.result, '/App/App.HubDefs/HubDef[@Name=\'MyCustomHub\']/HubDef.Logs/Logs/Log.Fields');
  });

  test('Should not match non-HubDef paths', () => {
    const xpath = '/App/EntityDefs/EntityDef[@Name=\'SomeEntity\']/Attributes';
    const affectingTokens = new Map([['entity', 'SomeEntity']]);
    const tokenDefinitions: TestTokenNameDefinition[] = [{
      id: 'hubdef-entity',
      name: 'HubDef Entity Token',
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
    
    const result = applyInjectionPathTemplate(xpath, affectingTokens, tokenDefinitions as any);
    
    assert.strictEqual(result.success, true, 'Should succeed but not apply template');
    assert.strictEqual(result.result, xpath, 'Should return original path unchanged');
  });

  // Regression tests for EntityDef paths (ensure we didn't break existing functionality)
  test('Should still work with EntityDef paths (regression)', () => {
    const xpath = '/App/EntityDefs/EntityDef[@Name=\'Field\']/Attributes';
    const affectingTokens = new Map([['entity', 'Field']]);
    const tokenDefinitions: TestTokenNameDefinition[] = [{
      id: 'entitydef-entity',
      name: 'EntityDef Entity Token',
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
    
    const result = applyInjectionPathTemplate(xpath, affectingTokens, tokenDefinitions as any);
    
    assert.strictEqual(result.success, true, 'Should successfully apply template');
    assert.strictEqual(result.result, '/App/EntityDefs/EntityDef[@Name=\'Field\']/Attributes');
  });

  // Regression tests for DataStore paths  
  test('Should still work with DataStore Table paths (regression)', () => {
    const xpath = '/App/DataStore/Tables/Table/Columns';
    const affectingTokens = new Map([['entity', 'RFI']]);
    const tokenDefinitions: TestTokenNameDefinition[] = [{
      id: 'datastore-entity',
      name: 'DataStore Entity Token',
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
    
    const result = applyInjectionPathTemplate(xpath, affectingTokens, tokenDefinitions as any);
    
    assert.strictEqual(result.success, true, 'Should successfully apply template');
    assert.strictEqual(result.result, '/App/DataStore/Tables/Table[@EntityDefName=\'RFI\']/Columns');
  });
});