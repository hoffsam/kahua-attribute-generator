// Debug script to check what might be preventing the menu from showing
// This helps identify if it's a context issue, config issue, or something else

const fs = require('fs');

console.log('=== Menu Context Debug Analysis ===\n');

// Check if extension is compiled
const extensionExists = fs.existsSync('./out/extension.js');
console.log('1. Extension compiled:', extensionExists);

if (extensionExists) {
  const extensionContent = fs.readFileSync('./out/extension.js', 'utf8');
  console.log('   - Has setContext calls:', extensionContent.includes('setContext'));
  console.log('   - Has hasApplicableDocument:', extensionContent.includes('hasApplicableDocument'));
  console.log('   - Has context key constants:', extensionContent.includes('DOCUMENT_APPLICABLE_CONTEXT_KEY'));
}

// Check package.json menu configuration
const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
console.log('\n2. Menu Configuration:');

const contextMenus = packageJson.contributes?.menus?.['editor/context'] || [];
const kahuaSubmenu = packageJson.contributes?.menus?.['kahua.submenu'] || [];

console.log('   - Context menu items:', contextMenus.length);
contextMenus.forEach((menu, i) => {
  console.log(`   - Menu ${i+1}: submenu=${menu.submenu}, when="${menu.when}"`);
});

console.log('   - Submenu items:', kahuaSubmenu.length);
kahuaSubmenu.forEach((menu, i) => {
  console.log(`   - Item ${i+1}: command=${menu.command}, when="${menu.when}"`);
});

// Check configuration defaults
console.log('\n3. Configuration Defaults:');
const config = packageJson.contributes?.configuration?.properties || {};
const relevantConfigs = Object.keys(config).filter(key => key.includes('showInContextMenu') || key.includes('Menu'));
relevantConfigs.forEach(key => {
  console.log(`   - ${key}: ${config[key].default}`);
});

console.log('\n4. Required Context Variables for Menu:');
console.log('   For main submenu: config.kahua.showInContextMenu && kahua.hasApplicableDocument');
console.log('   For template item: config.kahua.showTemplatesInMenu && kahua.hasApplicableDocument && kahua.canGenerateTemplates');
console.log('   For snippet item: config.kahua.showSnippetsInMenu && kahua.hasApplicableDocument && kahua.canGenerateSnippets');
console.log('   For table item: config.kahua.showTablesInMenu && kahua.hasApplicableDocument && kahua.canGenerateTables');

console.log('\n5. Context Setting Functions:');
if (extensionExists) {
  const extensionContent = fs.readFileSync('./out/extension.js', 'utf8');
  
  // Look for context setting patterns
  const setContextMatches = extensionContent.match(/setContext['"]\s*,\s*['"][^'"]+['"]\s*,/g) || [];
  console.log('   - setContext calls found:', setContextMatches.length);
  
  // Look for debug patterns
  const debugMatches = extensionContent.match(/setDocumentTypeContext|updateDocumentTypeContext/g) || [];
  console.log('   - Document type context functions:', debugMatches.length);
}

console.log('\n=== Troubleshooting Steps ===');
console.log('1. Open a Kahua XML file in VS Code');
console.log('2. Check VS Code Output panel -> Extension Host for [KAHUA] debug messages');
console.log('3. Check VS Code Command Palette for "Developer: Reload Window" to refresh extension');
console.log('4. Try "Developer: Toggle Developer Tools" -> Console for any errors');

console.log('\n=== Quick Fix Test ===');
console.log('Try this command in VS Code Command Palette:');
console.log('> Developer: Set Context Key');
console.log('Key: kahua.hasApplicableDocument');
console.log('Value: true');
console.log('Then right-click to see if menu appears');

