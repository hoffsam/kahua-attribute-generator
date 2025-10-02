// Test the regex pattern matching issue
const testString = `DataType="Text"{'Text'=='Lookup' ? ' LookupListName="KahuaPa.Myentity_AttributeALookupList"' : ''}{'Text'=='Entity' ? ' LinkedEntityDef=""' : ''} IsConfigurable="true"`;

console.log('Testing string:', testString);

// Test the regex pattern I used
const conditionalPattern = /\{[^{}]*\?[^{}]*:[^{}]*\}/g;
const matches = testString.match(conditionalPattern);
console.log('\nRegex matches:', matches);

// If that doesn't work, let's try a different approach
const alternativePattern = /\{[^}]+\}/g;
const allBraceMatches = testString.match(alternativePattern);
console.log('All {} matches:', allBraceMatches);

// Let's also test the ternary parsing manually
const testExpression = "'Text'=='Lookup' ? ' LookupListName=\"KahuaPa.Myentity_AttributeALookupList\"' : ''";
console.log('\nTesting ternary parsing on:', testExpression);

// Simple ternary parsing
function simpleTernaryParse(expr) {
    const questionPos = expr.indexOf('?');
    const colonPos = expr.lastIndexOf(':');
    
    if (questionPos > 0 && colonPos > questionPos) {
        const condition = expr.substring(0, questionPos).trim();
        const trueValue = expr.substring(questionPos + 1, colonPos).trim();
        const falseValue = expr.substring(colonPos + 1).trim();
        
        return { condition, trueValue, falseValue };
    }
    return null;
}

const parsed = simpleTernaryParse(testExpression);
console.log('Parsed:', parsed);

if (parsed) {
    // Test condition evaluation
    console.log('\nEvaluating condition:', parsed.condition);
    
    // For 'Text'=='Lookup'
    const conditionResult = parsed.condition === "'Text'=='Lookup'" ? false : true;
    console.log('Condition result:', conditionResult);
    
    const chosenValue = conditionResult ? parsed.trueValue : parsed.falseValue;
    console.log('Chosen value:', chosenValue);
}

// Test what the extension actually sees
console.log('\n=== TESTING ACTUAL PROCESSING ===');
const actualExample = "{'Text'=='Lookup' ? ' LookupListName=\"KahuaPa.Myentity_AttributeALookupList\"' : ''}";
console.log('Actual conditional to process:', actualExample);

// This should match
const singleMatch = actualExample.match(conditionalPattern);
console.log('Does our regex match this?', singleMatch);