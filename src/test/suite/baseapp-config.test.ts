import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';

function parseHintsForTest(rawPath: string) {
  const segments = rawPath.split('/').filter(part => part.length > 0);
  const hints: Array<{ segmentIndex: number; attributes: string[] }> = [];
  const sanitizedSegments = segments.map((segment, index) => {
    const normalizedSegment = segment.replace(/\\"/g, '"');
    const hintMatch = normalizedSegment.match(/\((?:"[^"]+"(?:\|"[^"]+")*)\)\s*$/);
    if (!hintMatch) {
      return normalizedSegment;
    }

    const hintContent = hintMatch[0];
    const sanitizedSegment = normalizedSegment.slice(0, normalizedSegment.length - hintContent.length);
    const attributes = hintContent
      .slice(1, -1)
      .split('|')
      .map(attr => attr.replace(/"/g, '').trim())
      .filter(Boolean);

    if (attributes.length > 0) {
      hints.push({ segmentIndex: index, attributes });
    }

    return sanitizedSegment;
  });

  return {
    path: sanitizedSegments.join('/'),
    hints
  };
}

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
      const rawPath = attributesFragment.injectionPaths.DataStore as string;
      assert.ok(rawPath.includes('{appname}.{entity}'), 'Path should include entity token substitution');

      const parsed = parseHintsForTest(rawPath);
      assert.strictEqual(
        parsed.path,
        "App/DataStore/Tables/Table[@EntityDefName='{appname}.{entity}']/Columns",
        'DataStore injection should normalize to token-aware path'
      );
      assert.deepStrictEqual(parsed.hints, [
        { segmentIndex: 1, attributes: ['Id'] },
        { segmentIndex: 3, attributes: ['EntityDefName', 'Name'] }
      ]);
    });
  });
});
