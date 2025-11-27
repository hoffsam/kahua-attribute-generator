import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';

suite('Extension vs Base App Display Tests', () => {
  
  suite('Configuration Validation', () => {
    
    test('should have attributes fragment configured correctly', () => {
      // Read the package.json from the project root
      const packageJsonPath = path.join(__dirname, '..', '..', '..', 'package.json');
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      
      // Extract fragment definitions
      const fragmentDefs = packageJson.contributes.configuration.properties['kahua.fragmentDefinitions'].default;
      const attributesFragment = fragmentDefs.find((def: any) => def.id === 'attributes');
      
      // Validate attributes fragment definition exists
      assert.ok(attributesFragment, 'Should find attributes fragment definition');
      assert.strictEqual(attributesFragment.name, 'Extension Attributes', 'Fragment should be named Extension Attributes');
      
      // Validate tokenReferences include appname
      assert.ok(attributesFragment.tokenReferences.includes('appname'), 'tokenReferences should include appname');
      assert.ok(attributesFragment.tokenReferences.includes('attributes'), 'tokenReferences should include attributes');
      
      // Extract token definitions
      const tokenDefs = packageJson.contributes.configuration.properties['kahua.tokenNameDefinitions'].default;
      const appnameTokenDef = tokenDefs.find((def: any) => def.id === 'appname');
      
      // Validate appname token definition exists
      assert.ok(appnameTokenDef, 'Should find appname token definition');
      assert.ok(!appnameTokenDef.tokenReadPaths.baseapp, 'Should not have baseapp tokenReadPath');
    });
    
    test('should have DataStore injection path configured correctly', () => {
      const packageJsonPath = path.join(__dirname, '..', '..', '..', 'package.json');
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      
      const fragmentDefs = packageJson.contributes.configuration.properties['kahua.fragmentDefinitions'].default;
      const attributesFragment = fragmentDefs.find((def: any) => def.id === 'attributes');
      
      assert.ok(attributesFragment, 'Should find attributes fragment definition');
      assert.ok(attributesFragment.injectionPaths.DataStore, 'Should have DataStore injection path');
      assert.strictEqual(attributesFragment.injectionPaths.DataStore, 
        'App/DataStore/Tables/Table[@EntityDefName=\'{appname}.{entity}\']/Columns',
        'DataStore injection should use token substitution for smart resolution');
    });
  });
});