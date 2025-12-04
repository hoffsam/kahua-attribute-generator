/**
 * Test script to reproduce template generation and detection issue
 */

// Simulate the template generation process
function generateTestTemplate() {
    // Simulate selectedFragmentDefs
    const selectedFragmentDefs = [
        { id: 'attributes', name: 'Extension Attributes' }
    ];
    
    const fragmentIds = selectedFragmentDefs.map(f => f.id).join(', ');
    const fragmentName = selectedFragmentDefs.map(f => f.name).join(', ');
    const templateLines = [];
    
    // This mimics the FIXED template generation code (using fragment IDs, not names)
    templateLines.push(`// Kahua Template for ${fragmentIds.toLowerCase()}`);
    templateLines.push(`// Source: test-source.xml`);
    templateLines.push(`// Source URI: file:///test/source.xml`);
    templateLines.push('// Token Template for ' + fragmentName + ' (' + fragmentIds + '):');
    templateLines.push('// ----------------------------------------------------------------');
    templateLines.push(`// Entity Context: Contract`);
    templateLines.push('// All template rows will target this entity. Update this header if you change entities.');
    templateLines.push('// Smart injection will automatically use this entity for Attributes, Labels, and DataTags.');
    templateLines.push('// ----------------------------------------------------------------');
    templateLines.push('');
    templateLines.push('appname,entity,name,type,visualtype,label,descriptionlabel,linkedEntityDef');
    templateLines.push('kahua_Contract_extension,Contract,MyAttribute,Text,TextBox,My Label,My Description,');
    
    const templateContent = templateLines.join('\n');
    console.log('=== GENERATED TEMPLATE CONTENT ===');
    console.log(templateContent);
    console.log('=== END TEMPLATE CONTENT ===\n');
    
    return templateContent;
}

// Simulate the fragment detection process
function testFragmentDetection(templateContent) {
    console.log('=== TESTING FRAGMENT DETECTION ===');
    
    const lines = templateContent.split('\n');
    console.log(`Processing ${lines.length} lines`);
    
    for (let i = 0; i < Math.min(10, lines.length); i++) {
        const text = lines[i].trim();
        console.log(`Line ${i}: "${text}"`);
        
        if (!text.startsWith('//')) {
            console.log(`  -> Skipping (not a comment)`);
            continue;
        }

        // Test the regex pattern
        const match = text.match(/^\/\/\s*(?:kahua\s+)?(?:template|snippet|table)\s+for\s+(.+)$/i);
        if (match) {
            console.log(`  -> MATCH FOUND!`);
            console.log(`     Full match: "${match[0]}"`);
            console.log(`     Captured group: "${match[1]}"`);
            const fragmentsText = match[1].split(/[,&]/)[0].trim();
            console.log(`     Extracted fragment: "${fragmentsText}"`);
            const result = [fragmentsText.toLowerCase()];
            console.log(`     Final result: ${JSON.stringify(result)}`);
            return result;
        } else {
            console.log(`  -> No match`);
        }
    }

    console.log('No fragment patterns found, checking for fallback indicators');
    
    // Test fallback detection
    for (let i = 0; i < Math.min(10, lines.length); i++) {
        const text = lines[i].trim();
        
        // Look for CSV headers that might indicate fragment types
        if (text.includes('name,type') && text.includes(',')) {
            console.log(`Line ${i}: Found CSV header suggesting attributes fragment`);
            return ['attributes'];
        }
        
        // Look for other comment patterns that might help
        if (text.match(/\/\/.*(?:attribute|lookup|tag)/i)) {
            console.log(`Line ${i}: Found hint in comment: "${text}"`);
            if (text.match(/attribute/i)) return ['attributes'];
            if (text.match(/lookup/i)) return ['lookups'];
            if (text.match(/tag/i)) return ['datatags'];
        }
    }

    console.log('No fragment IDs could be inferred');
    return [];
}

// Test different variations
function testVariations() {
    console.log('\n=== TESTING VARIATIONS ===');
    
    const variations = [
        '// Kahua Template for extension attributes',
        '// Kahua Template for Extension Attributes',
        '// Kahua Template for attributes',
        '// kahua template for attributes',
        '//Kahua Template for attributes',
        '// Template for attributes',
        '// Kahua Snippet for lookups',
        '// Kahua Table for datatags'
    ];
    
    variations.forEach((line, index) => {
        console.log(`\nVariation ${index + 1}: "${line}"`);
        const match = line.match(/^\/\/\s*(?:kahua\s+)?(?:template|snippet|table)\s+for\s+(.+)$/i);
        if (match) {
            console.log(`  -> MATCHES! Captured: "${match[1]}"`);
            const fragmentsText = match[1].split(/[,&]/)[0].trim();
            console.log(`  -> Fragment: "${fragmentsText.toLowerCase()}"`);
        } else {
            console.log(`  -> NO MATCH`);
        }
    });
}

// Run the tests
function runTest() {
    console.log('🧪 TEMPLATE GENERATION AND DETECTION TEST\n');
    
    // Generate a test template
    const templateContent = generateTestTemplate();
    
    // Test fragment detection on it
    const detectedFragments = testFragmentDetection(templateContent);
    
    console.log('\n=== FINAL RESULT ===');
    if (detectedFragments.length > 0) {
        console.log(`✅ SUCCESS: Detected fragments: ${JSON.stringify(detectedFragments)}`);
    } else {
        console.log(`❌ FAILURE: Could not determine which fragments this template uses`);
    }
    
    // Test regex variations
    testVariations();
}

// Run the test
runTest();

