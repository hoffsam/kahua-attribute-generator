// Simple test to verify conditional fragment detection logic
console.log('=== Testing Conditional Fragment Detection ===\n');

// Test data from your configuration
const fragmentTemplates = {
  "body": {
    "Attributes": "<Attribute Name=\"{$name}\" />",
    "Labels": "<Label Key=\"{$entity}_{$name}Label\">{$label}</Label>",
    "{'{$type}'=='Lookup' ? 'LookupListLabels' : ''}": "<Label Key=\"{$entity}_{$name}LookupListLabel\">{$label}</Label>",
    "VisualsEditView": "<{$visualtype} Name=\"{$name}\" />",
    "{'{$type}'=='Lookup' ? 'LookupList' : ''}": "<LookupList Name=\"{$name}\">\n   <Value />\n</LookupList>"
  }
};

// Mock the logic from processFragmentTemplates
function testConditionalDetection() {
  const processedFragments = {};
  const conditionalFragments = {};
  
  console.log('Input fragment templates:');
  console.log('Keys:', Object.keys(fragmentTemplates));
  console.log();
  
  for (const [key, template] of Object.entries(fragmentTemplates)) {
    console.log(`Processing top-level key: "${key}"`);
    
    if (typeof template === 'object') {
      console.log('  -> This is a nested structure (body)');
      
      // Handle nested structure
      for (const [subKey, subTemplate] of Object.entries(template)) {
        console.log(`  Processing nested key: "${subKey}"`);
        
        const strippedSubKey = subKey.replace(/^"(.*)"$/, '$1');
        // Fixed regex to handle nested braces like {$token}
        const isConditional = strippedSubKey.match(/^\{.*\?.*:.*\}.*$/);
        
        console.log(`    Stripped key: "${strippedSubKey}"`);
        console.log(`    Regex test result: ${!!isConditional}`);
        
        if (isConditional) {
          console.log(`    ✓ DETECTED as conditional`);
          conditionalFragments[subKey] = subTemplate;
        } else {
          console.log(`    ✓ DETECTED as non-conditional`);
          processedFragments[subKey] = subTemplate;
        }
        console.log();
      }
    } else {
      // Handle flat structure
      const strippedKey = key.replace(/^"(.*)"$/, '$1');
      const isConditional = strippedKey.match(/^\{[^{}]*\?[^{}]*:[^{}]*\}.*$/);
      
      if (isConditional) {
        conditionalFragments[key] = template;
      } else {
        processedFragments[key] = template;
      }
    }
  }
  
  console.log('=== DETECTION RESULTS ===');
  console.log('Non-conditional fragments (processedFragments):');
  Object.keys(processedFragments).forEach(key => console.log(`  - "${key}"`));
  console.log();
  
  console.log('Conditional fragments (conditionalFragments):');
  Object.keys(conditionalFragments).forEach(key => console.log(`  - "${key}"`));
  console.log();
  
  return { processedFragments, conditionalFragments };
}

// Test conditional evaluation
function testConditionalEvaluation() {
  console.log('=== Testing Conditional Evaluation ===\n');
  
  const { conditionalFragments } = testConditionalDetection();
  
  const testRows = [
    { name: 'AttributeA', type: 'Text', entity: 'MyEntity' },
    { name: 'AttributeB', type: 'Lookup', entity: 'MyEntity' }
  ];
  
  testRows.forEach((row, index) => {
    console.log(`--- Row ${index + 1}: ${row.name} (type=${row.type}) ---`);
    
    for (const [conditionalKey, template] of Object.entries(conditionalFragments)) {
      const strippedKey = conditionalKey.replace(/^"(.*)"$/, '$1');
      let processedKey = strippedKey;
      
      // Replace {$type} with actual value
      processedKey = processedKey.replace(/\{\$type\}/g, row.type);
      
      console.log(`  Conditional: "${conditionalKey}"`);
      console.log(`  After token replacement: "${processedKey}"`);
      
      // Simple evaluation
      let result = '';
      if (processedKey.includes(`'${row.type}'=='Lookup'`)) {
        if (row.type === 'Lookup') {
          if (processedKey.includes('LookupListLabels')) {
            result = 'LookupListLabels';
          } else if (processedKey.includes('LookupList')) {
            result = 'LookupList';
          }
        }
        // If type !== 'Lookup', result stays empty
      }
      
      console.log(`  Evaluation result: "${result}"`);
      console.log(`  Should be included: ${result !== ''}`);
      console.log();
    }
  });
}

// Run the tests
testConditionalDetection();
testConditionalEvaluation();

console.log('✅ Test completed!');