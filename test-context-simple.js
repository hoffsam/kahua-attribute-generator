// Simple test to verify context detection without VS Code dependency
const fs = require('fs');

// Mock the required VS Code types
const mockDocument = {
  languageId: 'xml',
  uri: {
    fsPath: 'test-kahua.xml',
    toString: () => 'file:///test-kahua.xml'
  },
  getText: () => fs.readFileSync('test-kahua.xml', 'utf8')
};

// Mock configuration
const mockConfig = {
  "kahua.documentTypes": [
    {
      "id": "extension", 
      "name": "Extension",
      "priority": 300,
      "rules": [
        { "kind": "rootElement", "value": "App" },
        { "kind": "attributeExists", "xpath": "App", "attribute": "Extends" },
        { "kind": "xpathNotExists", "xpath": "App/App.Supplements" }
      ]
    },
    {
      "id": "attributes",
      "name": "Base App", 
      "priority": 250,
      "rules": [
        { "kind": "rootElement", "value": "App" },
        { "kind": "xpathNotExists", "xpath": "App/App.Supplements" }
      ]
    },
    {
      "id": "supplement",
      "name": "Supplement XML",
      "priority": 100, 
      "rules": [
        { "kind": "rootElement", "value": "App" },
        { "kind": "xpathExists", "xpath": "App/App.Supplements" }
      ]
    }
  ]
};

console.log('Testing context detection...');
console.log(`Document language: ${mockDocument.languageId}`);
console.log(`Document path: ${mockDocument.uri.fsPath}`);

const xmlContent = mockDocument.getText();
console.log(`XML content preview: ${xmlContent.substring(0, 200)}...`);

// Simple XML root element detection
const rootMatch = xmlContent.match(/<(\w+)(?:\s|>)/);
const rootElement = rootMatch ? rootMatch[1] : null;
console.log(`Root element detected: ${rootElement}`);

// Check if root is App
const hasAppRoot = rootElement === 'App';
console.log(`Has App root: ${hasAppRoot}`);

// Check for Extends attribute
const hasExtends = xmlContent.includes('Extends=');
console.log(`Has Extends attribute: ${hasExtends}`);

// Check for App.Supplements
const hasSupplements = xmlContent.includes('<App.Supplements');
console.log(`Has App.Supplements: ${hasSupplements}`);

// Determine expected document type
let expectedType = null;
if (hasAppRoot) {
  if (hasExtends && !hasSupplements) {
    expectedType = 'extension';
  } else if (!hasSupplements) {
    expectedType = 'attributes';
  } else if (hasSupplements) {
    expectedType = 'supplement';  
  }
}

console.log(`Expected document type: ${expectedType}`);
console.log(`Should show Kahua menu: ${expectedType !== null}`);