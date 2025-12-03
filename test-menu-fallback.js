/**
 * Test the menu fallback detection logic
 */

// Simulate the isBasicKahuaFile function
function isBasicKahuaFile(content) {
    if (!content.trim()) {
        return false;
    }
    
    // Quick check for <App> root element without full XML parsing
    const appElementMatch = content.match(/<App[\s>]/i);
    if (appElementMatch) {
        console.log(`Found <App> root element at position ${appElementMatch.index}`);
        return true;
    }
    
    return false;
}

// Test cases
const testCases = [
    {
        name: "Valid Kahua Extension",
        content: `<?xml version="1.0" encoding="utf-8"?>
<App Name="MyExtension" Extends="BaseApp">
  <EntityDefs>
    <EntityDef Name="Field"/>
  </EntityDefs>
</App>`,
        expected: true
    },
    {
        name: "Valid Kahua Base App", 
        content: `<?xml version="1.0"?>
<App Name="MyApp">
  <EntityDefs>
    <EntityDef Name="Project"/>
  </EntityDefs>
</App>`,
        expected: true
    },
    {
        name: "App with attributes",
        content: `<App Name="test" Version="1.0" DataScope="Default">
  <EntityDefs/>
</App>`,
        expected: true
    },
    {
        name: "Empty file",
        content: "",
        expected: false
    },
    {
        name: "Non-XML file", 
        content: "console.log('hello world');",
        expected: false
    },
    {
        name: "XML but not Kahua",
        content: `<?xml version="1.0"?>
<root>
  <item>test</item>
</root>`,
        expected: false
    },
    {
        name: "Malformed but has App",
        content: `<App Name="broken"
  <EntityDef/>`,
        expected: true
    }
];

console.log('🧪 TESTING MENU FALLBACK DETECTION\n');

let passed = 0;
let failed = 0;

testCases.forEach((testCase, index) => {
    const result = isBasicKahuaFile(testCase.content);
    const success = result === testCase.expected;
    
    console.log(`Test ${index + 1}: ${testCase.name}`);
    console.log(`Expected: ${testCase.expected}, Got: ${result} ${success ? '✅' : '❌'}`);
    
    if (success) {
        passed++;
    } else {
        failed++;
        console.log(`  Content preview: ${testCase.content.substring(0, 100)}...`);
    }
    console.log('');
    
    success ? passed++ : failed++;
});

console.log(`\n📊 RESULTS: ${passed} passed, ${failed} failed`);

if (failed === 0) {
    console.log('✅ All tests passed! Menu fallback should work correctly.');
} else {
    console.log('❌ Some tests failed. Menu fallback needs adjustment.');
}

console.log('\n🎯 FALLBACK STRATEGY:');
console.log('- Shows menu for ANY XML file with <App> root element');
console.log('- Works even if full document type detection fails');
console.log('- Prevents menu regression when XML parsing has issues');
console.log('- Lightweight regex check, no full XML parsing required');