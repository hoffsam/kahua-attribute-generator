/**
 * Debug script to understand menu visibility regression
 */

console.log('=== MENU VISIBILITY DEBUG ===\n');

// Simulate the menu visibility logic
function simulateMenuVisibility() {
    console.log('📋 MENU VISIBILITY CONDITIONS:');
    console.log('1. config.kahua.showInContextMenu = true (default)');
    console.log('2. kahua.hasApplicableDocument = Boolean(typeId)');
    console.log('');
    
    console.log('🔍 DOCUMENT TYPE DETECTION FLOW:');
    console.log('updateDocumentTypeContext() called on file open/change');
    console.log('  ↓');
    console.log('getOrDetectDocumentType()');
    console.log('  ↓');  
    console.log('detectDocumentTypeId()');
    console.log('  ↓');
    console.log('getDocumentTypeDefinitions() - Gets kahua.documentTypes config');
    console.log('  ↓');
    console.log('parseXmlForDocumentTypeDetection() - Parses XML');
    console.log('  ↓');
    console.log('resolveRootElementName() - Gets root element');
    console.log('  ↓');
    console.log('Matches against document type rules');
    console.log('  ↓');
    console.log('setDocumentTypeContext(typeId) - Sets kahua.hasApplicableDocument');
    console.log('');
    
    console.log('❌ POTENTIAL FAILURE POINTS:');
    console.log('1. No kahua.documentTypes configured in settings');
    console.log('2. XML parsing fails');
    console.log('3. Root element not detected as <App>');
    console.log('4. Document type rules don\'t match the XML');
    console.log('5. Context not being set properly');
    console.log('');
    
    console.log('🐛 WHY REGRESSION KEEPS HAPPENING:');
    console.log('- Menu visibility depends on document type detection');
    console.log('- Any change that affects XML parsing breaks menu');
    console.log('- No fallback when detection fails');
    console.log('- No explicit test for menu visibility');
    console.log('');
    
    console.log('✅ SOLUTION:');
    console.log('1. Add fallback detection for basic Kahua files');
    console.log('2. Show menu for any XML with <App> root element');
    console.log('3. Add explicit menu visibility test');
    console.log('4. Separate menu visibility from full document type detection');
}

function simulateDefaultDocumentTypes() {
    console.log('📝 DEFAULT DOCUMENT TYPES IN PACKAGE.JSON:');
    
    const defaultTypes = [
        {
            id: "baseapp",
            name: "Base App", 
            priority: 100,
            rules: [
                { kind: "rootElement", value: "App" },
                { kind: "attributeNotExists", xpath: "App", attribute: "Extends" }
            ]
        },
        {
            id: "extension",
            name: "Extension",
            priority: 300, 
            rules: [
                { kind: "rootElement", value: "App" },
                { kind: "attributeExists", xpath: "App", attribute: "Extends" },
                { kind: "xpathNotExists", xpath: "App/App.Supplements" }
            ]
        },
        {
            id: "supplement", 
            name: "Supplement",
            priority: 200,
            rules: [
                { kind: "rootElement", value: "App" },
                { kind: "xpathExists", xpath: "App/App.Supplements" }
            ]
        }
    ];
    
    console.log('Expected to match Kahua XML files with <App> root element');
    console.log('These should be automatically available...');
    console.log('');
    
    return defaultTypes;
}

function diagnoseIssue() {
    console.log('🔬 ROOT CAUSE ANALYSIS:');
    console.log('');
    
    console.log('The menu regression happens because:');
    console.log('1. Menu only shows when kahua.hasApplicableDocument = true');
    console.log('2. This is only true when document type detection succeeds'); 
    console.log('3. Any XML parsing or configuration issue breaks detection');
    console.log('4. No fallback means menu completely disappears');
    console.log('');
    
    console.log('🎯 IMMEDIATE FIX NEEDED:');
    console.log('Add basic fallback detection that shows menu for any XML with <App> root');
    console.log('This ensures menu always shows for Kahua files even if full detection fails');
}

simulateMenuVisibility();
simulateDefaultDocumentTypes();
diagnoseIssue();

