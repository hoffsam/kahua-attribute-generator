// Standalone test for document type detection
const fs = require('fs');

// Mock the configuration - default document types from package.json
const documentTypes = [
  {
    "id": "extension",
    "name": "Extension XML",
    "priority": 200,
    "rules": [
      {
        "kind": "rootElement",
        "value": "App"
      },
      {
        "kind": "xpathNotExists",
        "xpath": "App/App.Supplements"
      }
    ]
  },
  {
    "id": "supplement",
    "name": "Supplement XML",
    "priority": 100,
    "rules": [
      {
        "kind": "rootElement",
        "value": "App"
      },
      {
        "kind": "xpathExists",
        "xpath": "App/App.Supplements"
      }
    ]
  }
];

// Simple test implementation
function testDocumentTypeDetection() {
  const testFilePath = 'G:/OneDrive/Documents/vscode projects/xsd_analyzer_updated/example_files/example_xml/kahua_aec_rfi_extension.xml';
  
  if (!fs.existsSync(testFilePath)) {
    console.log(`Test file not found: ${testFilePath}`);
    return;
  }
  
  const content = fs.readFileSync(testFilePath, 'utf8');
  console.log('File content (first 200 chars):');
  console.log(content.substring(0, 200));
  
  // Extract root element
  const match = content.match(/<\s*([a-zA-Z][^\s>\/]*)/);
  const rootName = match ? match[1] : null;
  console.log(`Root element: '${rootName}'`);
  
  // Test each document type
  for (const docType of documentTypes) {
    console.log(`\nTesting document type: ${docType.id}`);
    
    let allRulesMatch = true;
    for (const rule of docType.rules) {
      console.log(`  Rule: ${rule.kind} = ${rule.value || rule.xpath}`);
      
      let ruleMatches = false;
      if (rule.kind === 'rootElement') {
        ruleMatches = rootName && rootName.toLowerCase() === rule.value.toLowerCase();
        console.log(`    rootElement check: '${rootName}' === '${rule.value}' -> ${ruleMatches}`);
      } else if (rule.kind === 'xpathExists') {
        // Simple check for App.Supplements
        ruleMatches = content.includes('<App.Supplements') || content.includes('<App.Supplements>');
        console.log(`    xpathExists check for '${rule.xpath}': ${ruleMatches}`);
      } else if (rule.kind === 'xpathNotExists') {
        // Simple check for App.Supplements - should NOT exist
        const exists = content.includes('<App.Supplements') || content.includes('<App.Supplements>');
        ruleMatches = !exists;
        console.log(`    xpathNotExists check for '${rule.xpath}': element exists=${exists}, rule matches=${ruleMatches}`);
      }
      
      if (!ruleMatches) {
        allRulesMatch = false;
      }
    }
    
    console.log(`  Document type '${docType.id}' matches: ${allRulesMatch}`);
    
    if (allRulesMatch) {
      console.log(`*** DETECTED DOCUMENT TYPE: ${docType.id} ***`);
      return docType.id;
    }
  }
  
  console.log('*** NO DOCUMENT TYPE MATCHED ***');
  return undefined;
}

testDocumentTypeDetection();