// Test separated regex patterns - working values + fixed fragments

// Original working pattern for values (handles simple cases without nested braces)
const VALUE_CONDITIONAL_PATTERN = /\{[^{}]*\?[^{}]*:[^{}]*\}/g;

// New pattern for fragment keys (handles nested braces like {$token})
const FRAGMENT_CONDITIONAL_PATTERN = /\{.*\?.*:.*\}/;

console.log('=== Testing Separated Regex Patterns ===\n');

// Test cases for value conditionals (should still work with original pattern)
const valueTestCases = [
  {
    name: 'Simple value conditional (no nested braces)',
    input: '<Element {$type=="Lookup" ? "class=lookup" : ""} />',
    expected: ['{$type=="Lookup" ? "class=lookup" : ""}'],
  },
  {
    name: 'Multiple simple conditionals',
    input: '<Element {$type=="A" ? "attr1" : ""} {$mode=="B" ? "attr2" : ""} />',
    expected: ['{$type=="A" ? "attr1" : ""}', '{$mode=="B" ? "attr2" : ""}'],
  }
];

// Test cases for fragment keys (need new pattern to handle nested braces)
const fragmentKeyTestCases = [
  {
    name: 'Fragment key with nested braces',
    input: "{'{$type}'=='Lookup' ? 'LookupList' : ''}",
    expected: true,
  },
  {
    name: 'Complex fragment key',
    input: "{'{$type}'=='Lookup' && '{$category}'=='Advanced' ? 'AdvancedLookup' : ''}",
    expected: true,
  },
  {
    name: 'Non-conditional fragment key',
    input: "Attributes",
    expected: false,
  }
];

console.log('--- Value Conditional Tests (Original Working Pattern) ---');
valueTestCases.forEach(testCase => {
  const matches = [];
  let match;
  const regex = new RegExp(VALUE_CONDITIONAL_PATTERN.source, 'g');
  
  while ((match = regex.exec(testCase.input)) !== null) {
    matches.push(match[0]);
  }
  
  console.log(`Test: ${testCase.name}`);
  console.log(`  Input: "${testCase.input}"`);
  console.log(`  Expected matches: ${testCase.expected.length}`);
  console.log(`  Actual matches: ${matches.length}`);
  
  const success = matches.length === testCase.expected.length && 
    matches.every((match, i) => match === testCase.expected[i]);
  
  console.log(`  Result: ${success ? '✅ PASS' : '❌ FAIL'}`);
  if (matches.length > 0) {
    matches.forEach((match, i) => console.log(`    ${i + 1}: "${match}"`));
  }
  console.log();
});

console.log('--- Fragment Key Tests (New Pattern for Nested Braces) ---');
fragmentKeyTestCases.forEach(testCase => {
  const anchoredPattern = new RegExp(`^${FRAGMENT_CONDITIONAL_PATTERN.source}.*$`);
  const matches = !!testCase.input.match(anchoredPattern);
  
  console.log(`Test: ${testCase.name}`);
  console.log(`  Input: "${testCase.input}"`);
  console.log(`  Expected: ${testCase.expected}, Got: ${matches}`);
  console.log(`  Result: ${matches === testCase.expected ? '✅ PASS' : '❌ FAIL'}`);
  console.log();
});

// Test the critical case that was broken
console.log('--- Critical Test: Original Problem Case ---');
const problematicFragmentKey = "{'{$type}'=='Lookup' ? 'LookupList' : ''}";
const originalBrokenPattern = /^\{[^{}]*\?[^{}]*:[^{}]*\}.*$/; // The broken one
const newWorkingPattern = new RegExp(`^${FRAGMENT_CONDITIONAL_PATTERN.source}.*$`); // The fixed one

console.log(`Problematic fragment key: "${problematicFragmentKey}"`);
console.log(`Old broken pattern detects: ${!!problematicFragmentKey.match(originalBrokenPattern)}`);
console.log(`New working pattern detects: ${!!problematicFragmentKey.match(newWorkingPattern)}`);
console.log();

// Verify value conditionals don't contain nested braces (so original pattern should be fine)
console.log('--- Value Conditional Pattern Assumptions ---');
const typicalValueConditionals = [
  "{$type=='Lookup' ? ' List=\"{$entity}_{$name}LookupList\"' : ''}",
  "{$required=='true' ? 'Required=\"true\"' : ''}",
  "{$mode=='edit' ? 'editable' : 'readonly'}"
];

console.log('Testing if value conditionals contain nested token references that would break original pattern:');
typicalValueConditionals.forEach((valueConditional, i) => {
  const hasNestedTokens = /\{[^{}]*\{\$[^}]+\}[^{}]*\}/.test(valueConditional);
  console.log(`  ${i + 1}: "${valueConditional}"`);
  console.log(`     Has nested {$token} inside conditional: ${hasNestedTokens ? '❌ YES (would break)' : '✅ NO (safe)'}`);
});

console.log('\n✅ Separated regex testing completed!');