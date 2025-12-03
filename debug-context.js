// Debug script to test context detection
const fs = require('fs');

// Read the test XML file
const xmlContent = fs.readFileSync('G:\\OneDrive\\Documents\\vscode projects\\kahua-attribute-generator\\test-kahua.xml', 'utf8');
console.log('XML Content (first 200 chars):', xmlContent.substring(0, 200));

// Check if it matches basic patterns
const hasAppRoot = xmlContent.includes('<App');
const hasExtends = xmlContent.includes('Extends=');
const hasSupplements = xmlContent.includes('App.Supplements');

console.log('Pattern checks:');
console.log('- Has <App root:', hasAppRoot);
console.log('- Has Extends attribute:', hasExtends);
console.log('- Has App.Supplements:', hasSupplements);

// Expected document type based on rules:
// extension: App + Extends + !App.Supplements -> false (no Extends)
// attributes (Base App): App + !Extends + !App.Supplements -> true
// supplement: App + App.Supplements -> false (no App.Supplements)

console.log('\nExpected matches:');
console.log('- Extension (App + Extends + !App.Supplements):', hasAppRoot && hasExtends && !hasSupplements);
console.log('- Base App (App + !Extends + !App.Supplements):', hasAppRoot && !hasExtends && !hasSupplements);
console.log('- Supplement (App + App.Supplements):', hasAppRoot && hasSupplements);

console.log('\nShould detect as: Base App');