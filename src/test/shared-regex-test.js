// Test the shared regex pattern
const CONDITIONAL_EXPRESSION_PATTERN = /\{.*\?.*:.*\}/;

console.log('=== Testing Shared Conditional Regex Pattern ===\n');

// Test cases for both fragment keys and value conditionals
const testCases = [
  {
    name: 'Fragment key with nested token',
    input: "{'{$type}'=='Lookup' ? 'LookupList' : ''}",
    expectedMatch: true,
    context: 'Fragment Key'
  },
  {
    name: 'Value conditional with nested token',
    input: "{'{$label}'!='' ? '{$label|friendly}' : '{$name|friendly}'}",
    expectedMatch: true,
    context: 'Value'
  },
  {
    name: 'Simple conditional',
    input: "{$type=='Lookup' ? 'value' : ''}",
    expectedMatch: true,
    context: 'Both'
  },
  {
    name: 'Complex nested conditional',
    input: "{$type=='Lookup' && '{$subtype}'=='Advanced' ? 'ComplexLookup' : ''}",
    expectedMatch: true,
    context: 'Both'
  },
  {
    name: 'Non-conditional text',
    input: "Attributes",
    expectedMatch: false,
    context: 'Both'
  },
  {
    name: 'Non-conditional with braces but no ternary',
    input: "{$name}",
    expectedMatch: false,
    context: 'Both'
  },
  {
    name: 'Multiple conditionals in template',
    input: '<Element {$type=="A" ? "attr1" : ""} {$mode=="B" ? "attr2" : ""} />',
    expectedMatch: true, // Should match first one
    context: 'Value'
  }
];

// Test for fragment key detection (with anchors)
console.log('--- Fragment Key Detection (with anchors) ---');
testCases.forEach(testCase => {
  if (testCase.context === 'Fragment Key' || testCase.context === 'Both') {
    // Fragment keys need anchored matching to match entire key
    const anchoredPattern = new RegExp(`^${CONDITIONAL_EXPRESSION_PATTERN.source}.*$`);
    const matches = testCase.input.match(anchoredPattern);
    const actualMatch = !!matches;
    
    console.log(`Test: ${testCase.name}`);
    console.log(`  Input: "${testCase.input}"`);
    console.log(`  Expected: ${testCase.expectedMatch}, Got: ${actualMatch}`);
    console.log(`  Result: ${actualMatch === testCase.expectedMatch ? '✅ PASS' : '❌ FAIL'}`);
    console.log();
  }
});

// Test for value conditional detection (global matching)
console.log('--- Value Conditional Detection (global matching) ---');
testCases.forEach(testCase => {
  if (testCase.context === 'Value' || testCase.context === 'Both') {
    // Value conditionals need global matching to find all occurrences
    const globalPattern = new RegExp(CONDITIONAL_EXPRESSION_PATTERN.source, 'g');
    const matches = [];
    let match;
    while ((match = globalPattern.exec(testCase.input)) !== null) {
      matches.push(match[0]);
    }
    const actualMatch = matches.length > 0;
    
    console.log(`Test: ${testCase.name}`);
    console.log(`  Input: "${testCase.input}"`);
    console.log(`  Expected: ${testCase.expectedMatch}, Got: ${actualMatch}`);
    if (matches.length > 0) {
      console.log(`  Matches found: ${matches.length}`);
      matches.forEach((match, i) => console.log(`    ${i + 1}: "${match}"`));
    }
    console.log(`  Result: ${actualMatch === testCase.expectedMatch ? '✅ PASS' : '❌ FAIL'}`);
    console.log();
  }
});

// Test the specific problematic pattern from the original issue
console.log('--- Original Issue Test ---');
const originalFragmentKey = "{'{$type}'=='Lookup' ? 'LookupListLabels' : ''}";
const anchoredPattern = new RegExp(`^${CONDITIONAL_EXPRESSION_PATTERN.source}.*$`);
const detectedAsConditional = !!originalFragmentKey.match(anchoredPattern);

console.log(`Original problematic fragment key: "${originalFragmentKey}"`);
console.log(`Detected as conditional: ${detectedAsConditional}`);
console.log(`Result: ${detectedAsConditional ? '✅ FIXED' : '❌ STILL BROKEN'}`);
console.log();

// Test token replacement simulation
console.log('--- Token Replacement Simulation ---');
let processedKey = originalFragmentKey;
processedKey = processedKey.replace(/\{\$type\}/g, 'Lookup'); // Simulate token replacement
console.log(`After token replacement: "${processedKey}"`);
console.log(`Should evaluate to: "LookupListLabels"`);

console.log('\n✅ Shared regex pattern testing completed!');