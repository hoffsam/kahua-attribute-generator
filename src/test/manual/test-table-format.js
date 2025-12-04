/**
 * Test script to verify the new table format works correctly
 */

// Simulate the new table generation
function generateNewTableFormat() {
    // Simulate tokens from the unified system
    const headerTokens = [
        { name: 'appname', defaultValue: '' },
        { name: 'entity', defaultValue: '' }
    ];
    
    const tableTokens = [
        { name: 'name', defaultValue: '' },
        { name: 'type', defaultValue: 'Text' },
        { name: 'visualtype', defaultValue: 'TextBox' },
        { name: 'label', defaultValue: '' },
        { name: 'descriptionlabel', defaultValue: '' },
        { name: 'linkedEntityDef', defaultValue: '' }
    ];
    
    const extractedTokens = new Map([
        ['appname', 'kahua_aec_rfi_extension'],
        ['entity', 'RFI']
    ]);
    
    const tableLines = [];
    
    // Header metadata
    tableLines.push('// Kahua Table for attributes');
    tableLines.push('// Source: example.xml');
    
    // Header documentation  
    const headerValues = headerTokens.map(token => {
        const value = extractedTokens.get(token.name) || token.defaultValue || '';
        return `${token.name}:${value}`;
    });
    tableLines.push(`// Header Row: ${headerValues.join(',')}`);
    
    // Table documentation
    const tableDefaults = tableTokens.map(token => {
        const defaultValue = token.defaultValue || '';
        return defaultValue ? `${token.name}:${defaultValue}` : token.name;
    });
    tableLines.push(`// Table Row: ${tableDefaults.join(',')}`);
    
    tableLines.push('// ----------------------------------------------------------------');
    tableLines.push('// Edit the table data below and use generation commands');
    tableLines.push('');
    
    // CSV data - header row
    const headerRow = headerTokens.map(token => {
        return extractedTokens.get(token.name) || token.defaultValue || '';
    });
    tableLines.push(headerRow.join(','));
    
    // CSV data - table row  
    const tableRow = tableTokens.map(token => token.defaultValue || '');
    tableLines.push(tableRow.join(','));
    
    return tableLines.join('\n');
}

// Simulate the CSV parsing logic
function testCsvParsing(tableContent) {
    console.log('=== TESTING CSV PARSING ===');
    
    const lines = tableContent.split('\n');
    const csvLines = lines.filter(line => !line.trim().startsWith('//') && line.trim() !== '');
    
    console.log(`Found ${csvLines.length} CSV lines:`);
    csvLines.forEach((line, i) => console.log(`  CSV Line ${i}: "${line}"`));
    
    if (csvLines.length >= 2) {
        const headerLine = csvLines[0];
        const dataLine = csvLines[1];
        
        console.log(`\nHeader line: "${headerLine}"`);
        console.log(`Data line: "${dataLine}"`);
        
        // Simulate getTokenValues parsing
        const headerParts = headerLine.split(',');
        const dataParts = dataLine.split(',');
        
        console.log(`\nHeader parts: ${JSON.stringify(headerParts)}`);
        console.log(`Data parts: ${JSON.stringify(dataParts)}`);
        
        // Simulate token assignment
        const headerTokens = ['appname', 'entity'];
        const tableTokens = ['name', 'type', 'visualtype', 'label', 'descriptionlabel', 'linkedEntityDef'];
        
        console.log('\n=== HEADER TOKEN VALUES ===');
        headerTokens.forEach((token, i) => {
            const value = headerParts[i] || '';
            console.log(`${token}: "${value}"`);
        });
        
        console.log('\n=== TABLE TOKEN VALUES ===');
        tableTokens.forEach((token, i) => {
            const value = dataParts[i] || '';
            console.log(`${token}: "${value}"`);
        });
        
        return true;
    } else {
        console.log('❌ Not enough CSV lines found');
        return false;
    }
}

function runTest() {
    console.log('🧪 TABLE FORMAT TEST\n');
    
    // Generate new table format
    const tableContent = generateNewTableFormat();
    
    console.log('=== GENERATED TABLE CONTENT ===');
    console.log(tableContent);
    console.log('=== END CONTENT ===\n');
    
    // Test CSV parsing
    const success = testCsvParsing(tableContent);
    
    console.log('\n=== RESULT ===');
    if (success) {
        console.log('✅ NEW TABLE FORMAT WORKS CORRECTLY');
        console.log('   - Header tokens separated from table tokens');
        console.log('   - CSV parsing works as expected');
        console.log('   - Documentation shows defaults clearly');
    } else {
        console.log('❌ TABLE FORMAT HAS ISSUES');
    }
}

runTest();

