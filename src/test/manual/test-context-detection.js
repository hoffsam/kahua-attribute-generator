// Test script to check document type detection
const fs = require('fs');

// Sample Kahua XML content for testing
const sampleKahuaContent = `<?xml version="1.0" encoding="UTF-8"?>
<App Extends="kahua_AEC_RFI" Name="kahua_aec_rfi_extension" DataScope="Default" AppScope="Partition" Version="1750">
  <EntityDefs>
    <EntityDef Name="RFI" IsAttachable="True">
      <Attributes>
        <AttributeDef Name="TestField" Type="Text" />
      </Attributes>
    </EntityDef>
  </EntityDefs>
</App>`;

// Check if this looks like a Kahua file
function isBasicKahuaFile(content) {
  const hasRootApp = /<App[\s>]/i.test(content);
  const hasEntityDefs = /<EntityDefs/i.test(content) || /<EntityDef/i.test(content);
  const hasKahuaElements = /<AttributeDef|<FieldDef|<LabelDef|<DataTagDef/i.test(content);
  
  return hasRootApp && (hasEntityDefs || hasKahuaElements);
}

// Simulate document type detection using regex (simplified)
function detectDocumentType(content) {
  try {
    // Extract root element
    const rootMatch = content.match(/<(\w+)[\s>]/);
    const rootElement = rootMatch ? rootMatch[1] : null;
    
    console.log('Root element:', rootElement);
    
    if (rootElement === 'App') {
      // Check for Extends attribute
      const extendsMatch = content.match(/<App[^>]*Extends=["']([^"']*)/);
      const hasExtends = !!extendsMatch;
      const extendsValue = extendsMatch ? extendsMatch[1] : null;
      
      // Check for App.Supplements
      const hasSupplements = /<App\.Supplements/.test(content);
      
      console.log('Has App element: true');
      console.log('Has Extends attribute:', hasExtends);
      console.log('Extends value:', extendsValue);
      console.log('Has App.Supplements:', hasSupplements);
      
      // Check document type rules
      if (hasExtends && !hasSupplements) {
        return 'extension';
      } else if (!hasExtends && !hasSupplements) {
        return 'baseapp';
      }
    }
  } catch (error) {
    console.error('Detection error:', error.message);
  }
  
  return null;
}

console.log('=== Testing Context Detection ===');
console.log('Sample content is basic Kahua file:', isBasicKahuaFile(sampleKahuaContent));
console.log('Detected document type:', detectDocumentType(sampleKahuaContent));

console.log('\n=== Testing with actual file ===');
const testFiles = [
  'G:\\OneDrive\\Documents\\vscode projects\\xsd_analyzer_updated\\example_files\\example_xml\\kahua_aec_rfi_extension.xml',
  'test-kahua.xml',
  'sample-datastore.xml'
];

testFiles.forEach(file => {
  try {
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, 'utf8');
      console.log(`\nFile: ${file}`);
      console.log('Is basic Kahua:', isBasicKahuaFile(content));
      console.log('Document type:', detectDocumentType(content));
    } else {
      console.log(`File not found: ${file}`);
    }
  } catch (error) {
    console.log(`Error reading ${file}:`, error.message);
  }
});

