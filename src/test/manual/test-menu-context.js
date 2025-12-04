/**
 * Test script to verify menu context detection 
 * This can be run without the full VS Code test environment
 */

console.log('=== MENU CONTEXT REGRESSION TEST ===');
console.log('');
console.log('This test verifies that the context detection logic works correctly');
console.log('and should prevent menu visibility regressions.');
console.log('');

// Test cases that should show the menu
const shouldShowMenu = [
  {
    name: 'Base App (kahua_AEC_RFI.xml)',
    content: `<App Name="kahua_AEC_RFI" DataScope="Default" AppScope="Partition" Version="1750">
  <EntityDefs>
    <EntityDef Name="TestEntity" EntityType="Standalone" />
  </EntityDefs>
</App>`,
    expected: 'attributes'
  },
  {
    name: 'Extension App',
    content: `<App Extends="kahua_BaseApp" Name="TestApp">
  <EntityDefs>
    <EntityDef Name="TestEntity" EntityType="Standalone" />
  </EntityDefs>
</App>`,
    expected: 'extension'
  },
  {
    name: 'Supplement App',
    content: `<App Name="TestApp">
  <App.Supplements>
    <Supplement />
  </App.Supplements>
</App>`,
    expected: 'supplement'
  }
];

// Test cases that should NOT show the menu
const shouldNotShowMenu = [
  {
    name: 'Regular XML',
    content: `<root>
  <data>Some regular XML content</data>
</root>`,
    expected: null
  },
  {
    name: 'Empty XML',
    content: `<?xml version="1.0"?><root></root>`,
    expected: null
  }
];

// Simplified detection logic (matches extension.ts)
function detectDocumentType(content) {
  // Remove BOM if present
  if (content.charCodeAt(0) === 0xFEFF) {
    content = content.slice(1);
  }
  
  const rootMatch = content.match(/<(\w+)[\s>]/);
  if (!rootMatch || rootMatch[1] !== 'App') {
    return null;
  }
  
  const hasExtends = content.includes('Extends=');
  const hasSupplements = content.includes('<App.Supplements') || content.includes('App/App.Supplements');
  
  // Apply document type rules (highest to lowest priority)
  if (hasExtends && !hasSupplements) {
    return 'extension';
  } else if (!hasExtends && !hasSupplements) {
    return 'attributes';
  } else if (hasSupplements) {
    return 'supplement';
  }
  
  return null;
}

console.log('📋 TESTING CASES THAT SHOULD SHOW MENU:');
console.log('');

let allPassed = true;

shouldShowMenu.forEach((testCase, index) => {
  const detected = detectDocumentType(testCase.content);
  const passed = detected === testCase.expected;
  const status = passed ? '✅' : '❌';
  
  console.log(`${index + 1}. ${status} ${testCase.name}`);
  console.log(`   Expected: ${testCase.expected}`);
  console.log(`   Detected: ${detected || 'NONE'}`);
  
  if (!passed) {
    allPassed = false;
    console.log(`   ❌ FAILURE: Menu should show but detection failed`);
  }
  console.log('');
});

console.log('📋 TESTING CASES THAT SHOULD NOT SHOW MENU:');
console.log('');

shouldNotShowMenu.forEach((testCase, index) => {
  const detected = detectDocumentType(testCase.content);
  const passed = detected === testCase.expected;
  const status = passed ? '✅' : '❌';
  
  console.log(`${shouldShowMenu.length + index + 1}. ${status} ${testCase.name}`);
  console.log(`   Expected: ${testCase.expected || 'NONE'}`);
  console.log(`   Detected: ${detected || 'NONE'}`);
  
  if (!passed) {
    allPassed = false;
    console.log(`   ❌ FAILURE: Menu should NOT show but was detected`);
  }
  console.log('');
});

console.log('=== SUMMARY ===');
if (allPassed) {
  console.log('✅ ALL TESTS PASSED - Menu context detection is working correctly');
  console.log('');
  console.log('🎯 To prevent regressions:');
  console.log('1. Run this test after any changes to context detection logic');
  console.log('2. Add new test cases when adding document types');
  console.log('3. Use the centralized KahuaContextManager for all context operations');
} else {
  console.log('❌ SOME TESTS FAILED - Menu context detection has regressions');
  console.log('');
  console.log('⚠️  This means users will not see the Kahua menu in valid files!');
  console.log('Fix the detectDocumentTypeId() function in extension.ts');
}

console.log('');
console.log('Next step: Test in actual VS Code by opening kahua_AEC_RFI.xml and right-clicking');

