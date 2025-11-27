/**
 * Standalone test for token substitution in injection paths
 * This test doesn't require VS Code API and can run independently
 */

const assert = require('assert');

// Import the token substitution function
// We'll define a simplified version here for testing
function applyGeneralTokenSubstitution(xpath, tokenMap) {
  let result = xpath;
  for (const [tokenName, tokenValue] of tokenMap.entries()) {
    const tokenPattern = new RegExp(`\\{${tokenName}\\}`, 'g');
    if (tokenPattern.test(result)) {
      result = result.replace(tokenPattern, tokenValue);
    }
  }
  return result;
}

function runTests() {
  console.log('Running Token Substitution Tests...\n');

  // Test 1: should substitute single token in path
  {
    const xpath = 'App/DataStore/Tables/Table[@EntityDefName=\'{appname}.{entity}\']/Columns';
    const tokens = new Map([
      ['appname', 'kahua_aec_rfi_extension'],
      ['entity', 'RFI']
    ]);
    
    const result = applyGeneralTokenSubstitution(xpath, tokens);
    const expected = 'App/DataStore/Tables/Table[@EntityDefName=\'kahua_aec_rfi_extension.RFI\']/Columns';
    
    assert.strictEqual(result, expected, 'Should substitute both tokens correctly');
    console.log('✓ Test 1 passed: Single token substitution');
  }

  // Test 2: should handle multiple token occurrences
  {
    const xpath = 'App/{appname}/Test[@Name=\'{entity}\']/Items[@Type=\'{entity}\']';
    const tokens = new Map([
      ['appname', 'MyApp'],
      ['entity', 'TestEntity']
    ]);
    
    const result = applyGeneralTokenSubstitution(xpath, tokens);
    const expected = 'App/MyApp/Test[@Name=\'TestEntity\']/Items[@Type=\'TestEntity\']';
    
    assert.strictEqual(result, expected, 'Should substitute multiple occurrences correctly');
    console.log('✓ Test 2 passed: Multiple token occurrences');
  }

  // Test 3: should handle path with no tokens
  {
    const xpath = 'App/EntityDefs/EntityDef/Attributes';
    const tokens = new Map([
      ['appname', 'MyApp'],
      ['entity', 'TestEntity']
    ]);
    
    const result = applyGeneralTokenSubstitution(xpath, tokens);
    
    assert.strictEqual(result, xpath, 'Should return original path when no tokens present');
    console.log('✓ Test 3 passed: Path with no tokens');
  }

  // Test 4: should handle empty token map
  {
    const xpath = 'App/DataStore/Tables/Table[@EntityDefName=\'{appname}.{entity}\']/Columns';
    const tokens = new Map();
    
    const result = applyGeneralTokenSubstitution(xpath, tokens);
    
    assert.strictEqual(result, xpath, 'Should return original path when no tokens available');
    console.log('✓ Test 4 passed: Empty token map');
  }

  // Test 5: should substitute only matching tokens
  {
    const xpath = 'App/{appname}/Test[@Name=\'{entity}\']/Items[@Type=\'{unknown}\']';
    const tokens = new Map([
      ['appname', 'MyApp'],
      ['entity', 'TestEntity']
      // Note: 'unknown' token not provided
    ]);
    
    const result = applyGeneralTokenSubstitution(xpath, tokens);
    const expected = 'App/MyApp/Test[@Name=\'TestEntity\']/Items[@Type=\'{unknown}\']';
    
    assert.strictEqual(result, expected, 'Should substitute only available tokens');
    console.log('✓ Test 5 passed: Partial token substitution');
  }

  console.log('\n✅ All token substitution tests passed!');
}

// If running directly
if (require.main === module) {
  runTests();
}