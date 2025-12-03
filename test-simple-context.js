// Simple test to verify VS Code integration is working
// This simulates opening the extension and checking context state

console.log('=== CONTEXT DEBUG TEST ===');
console.log('1. File should be detected as Base App');
console.log('2. kahua.hasApplicableDocument should be true');
console.log('3. Context menu should appear');

console.log('\nTo test:');
console.log('1. Open test-kahua.xml in VS Code');
console.log('2. Right-click in editor');
console.log('3. Look for Kahua submenu');
console.log('4. Check VS Code Developer Console for debug logs');

console.log('\nExpected debug logs:');
console.log('[KAHUA] updateDocumentTypeContext: Document detected as type: attributes');
console.log('[KAHUA] Setting kahua.hasApplicableDocument = true');
console.log('[KAHUA] setDocumentTypeContext: attributes');