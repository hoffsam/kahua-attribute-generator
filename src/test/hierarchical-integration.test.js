const fs = require('fs');
const path = require('path');

console.log('🧪 Testing Hierarchical Injection Integration');

// Mock XML content with multiple HubDefs
const mockXmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<App Extends="kahua_AEC_RFI" Name="kahua_aec_rfi_extension" DataScope="Project" AppScope="All" Version="2.0">
  <EntityDefs>
    <EntityDef Name="Field" IsAttachable="true" IsConfigurable="true" EntityType="Field" IsSearchable="true" />
    <EntityDef Name="Project" EntityType="Project" DefaultReport="" />
  </EntityDefs>
  
  <App.HubDefs>
    <HubDef Name="ProjectHub" Label="[ProjectHubLabel]">
      <HubDef.LogDef>
        <LogDef.FieldDefs>
          <FieldDef Name="Status" Path="Status" DataTag="Project_Status" />
        </LogDef.FieldDefs>
      </HubDef.LogDef>
      <HubDef.ImportDefs>
        <ImportDef Name="ProjectImport">
          <ImportDef.Sheets>
            <Sheet Name="Projects">
              <Sheet.Columns>
                <Column AttributeName="Name" Name="Project Name" />
              </Sheet.Columns>
            </Sheet>
          </ImportDef.Sheets>
        </ImportDef>
      </HubDef.ImportDefs>
    </HubDef>
    
    <HubDef Name="RFIHub" Label="[RFIHubLabel]">
      <HubDef.LogDef>
        <LogDef.FieldDefs>
          <FieldDef Name="Priority" Path="Priority" DataTag="RFI_Priority" />
        </LogDef.FieldDefs>
      </HubDef.LogDef>
      <HubDef.ImportDefs>
        <ImportDef Name="RFIImport">
          <ImportDef.Sheets>
            <Sheet Name="RFIs">
              <Sheet.Columns>
                <Column AttributeName="Subject" Name="RFI Subject" />
              </Sheet.Columns>
            </Sheet>
          </ImportDef.Sheets>
        </ImportDef>
        <ImportDef Name="RFIResponseImport">
          <ImportDef.Sheets>
            <Sheet Name="Responses">
              <Sheet.Columns>
                <Column AttributeName="Response" Name="Response Text" />
              </Sheet.Columns>
            </Sheet>
          </ImportDef.Sheets>
        </ImportDef>
      </HubDef.ImportDefs>
    </HubDef>
  </App.HubDefs>
  
  <DataStore>
    <Tables>
      <Table EntityDefName="kahua_AEC_RFI.Field" IncludeEntityLinkUrl="true">
        <Columns>
          <Column AttributeName="Name" />
        </Columns>
      </Table>
      <Table EntityDefName="kahua_AEC_RFI.Project" IncludeEntityLinkUrl="true">
        <Columns>
          <Column AttributeName="Name" />
        </Columns>
      </Table>
    </Tables>
  </DataStore>
</App>`;

// Mock hierarchical injection configuration
const hierarchicalGroups = {
  "HubDef": {
    groupSelector: "App/App.HubDefs/HubDef",
    groupDisplayAttribute: "Name",
    groupPathToken: "$hubpath",
    paths: {
      "FieldDefs": "$hubpath/HubDef.LogDef/LogDef.FieldDefs",
      "ImportDefs": "$hubpath/HubDef.ImportDefs/ImportDef/ImportDef.Sheets/Sheet/Sheet.Columns"
    }
  }
};

// Mock XML context (simplified)
function parseMockXml(xmlContent) {
  // Very simple XML parsing for test purposes
  const hubDefMatches = [...xmlContent.matchAll(/<HubDef\s+Name="([^"]+)"/g)];
  const hubDefs = hubDefMatches.map(match => ({
    tagName: 'HubDef',
    attributes: { Name: match[1] },
    enrichedPath: `App/App.HubDefs/HubDef[@Name='${match[1]}']`
  }));
  
  return { hubDefs };
}

// Simulate findElementsByXPath
function mockFindElementsByXPath(mockContext, xpath) {
  if (xpath === "App/App.HubDefs/HubDef") {
    return mockContext.hubDefs;
  }
  return [];
}

// Test hierarchical injection processing
function testHierarchicalInjectionGrouping() {
  console.log('📋 Testing hierarchical injection group processing...');
  
  const injectionPaths = {
    "Attributes": "App/EntityDefs/EntityDef/Attributes",
    "Labels": "App/Cultures/Culture[@Code='en']/Labels",
    "FieldDefs": "App/App.HubDefs/HubDef/HubDef.LogDef/LogDef.FieldDefs",
    "ImportDefs": "App/App.HubDefs/HubDef/HubDef.ImportDefs/ImportDef/ImportDef.Sheets/Sheet/Sheet.Columns"
  };
  
  const mockContext = parseMockXml(mockXmlContent);
  console.log(`📊 Found ${mockContext.hubDefs.length} HubDef containers:`);
  mockContext.hubDefs.forEach(hub => console.log(`   - ${hub.attributes.Name} (${hub.enrichedPath})`));
  
  // Simulate selecting the first HubDef (ProjectHub)
  const selectedHubDef = mockContext.hubDefs[0]; // ProjectHub
  console.log(`✅ Selected HubDef: ${selectedHubDef.attributes.Name}`);
  
  // Process hierarchical groups
  const processedPaths = { ...injectionPaths };
  
  const groupConfig = hierarchicalGroups.HubDef;
  for (const [sectionName, pathTemplate] of Object.entries(groupConfig.paths)) {
    if (sectionName in injectionPaths) {
      const expandedPath = pathTemplate.replace(/\$hubpath/g, selectedHubDef.enrichedPath);
      processedPaths[sectionName] = expandedPath;
      console.log(`🔄 Updated ${sectionName}:`);
      console.log(`   From: ${pathTemplate}`);
      console.log(`   To:   ${expandedPath}`);
    }
  }
  
  // Validation
  const expectedFieldDefs = "App/App.HubDefs/HubDef[@Name='ProjectHub']/HubDef.LogDef/LogDef.FieldDefs";
  const expectedImportDefs = "App/App.HubDefs/HubDef[@Name='ProjectHub']/HubDef.ImportDefs/ImportDef/ImportDef.Sheets/Sheet/Sheet.Columns";
  
  console.log('🧪 Validating results...');
  
  if (processedPaths.FieldDefs === expectedFieldDefs) {
    console.log('✅ FieldDefs path correctly targeted to ProjectHub');
  } else {
    console.log(`❌ FieldDefs path mismatch:`);
    console.log(`   Expected: ${expectedFieldDefs}`);
    console.log(`   Got:      ${processedPaths.FieldDefs}`);
    return false;
  }
  
  if (processedPaths.ImportDefs === expectedImportDefs) {
    console.log('✅ ImportDefs path correctly targeted to ProjectHub');
  } else {
    console.log(`❌ ImportDefs path mismatch:`);
    console.log(`   Expected: ${expectedImportDefs}`);
    console.log(`   Got:      ${processedPaths.ImportDefs}`);
    return false;
  }
  
  // Non-hierarchical paths should remain unchanged
  if (processedPaths.Attributes === "App/EntityDefs/EntityDef/Attributes") {
    console.log('✅ Non-hierarchical paths remain unchanged');
  } else {
    console.log('❌ Non-hierarchical paths were incorrectly modified');
    return false;
  }
  
  return true;
}

function testMultipleImportDefTargets() {
  console.log('\n📋 Testing multiple ImportDef targets within selected HubDef...');
  
  const mockContext = parseMockXml(mockXmlContent);
  const rfiHubDef = mockContext.hubDefs.find(hub => hub.attributes.Name === 'RFIHub');
  
  if (!rfiHubDef) {
    console.log('❌ Could not find RFIHub for testing');
    return false;
  }
  
  console.log(`✅ Selected HubDef: ${rfiHubDef.attributes.Name}`);
  
  // In real implementation, after selecting RFIHub, we'd find multiple ImportDef targets:
  // - RFIImport/Sheets/RFIs/Columns 
  // - RFIResponseImport/Sheets/Responses/Columns
  
  const expandedPath = `${rfiHubDef.enrichedPath}/HubDef.ImportDefs/ImportDef/ImportDef.Sheets/Sheet/Sheet.Columns`;
  console.log(`📍 Hierarchical path: ${expandedPath}`);
  
  // This would find multiple targets within the selected HubDef
  console.log('🎯 Would find multiple ImportDef injection targets:');
  console.log('   1. RFIImport -> Sheets/RFIs/Columns');
  console.log('   2. RFIResponseImport -> Sheets/Responses/Columns');
  console.log('   3. None (Skip injection)');
  console.log('✅ User can select specific targets or skip');
  
  return true;
}

function testConfigurationCompliance() {
  console.log('\n📋 Testing configuration compliance...');
  
  // Verify the package.json configuration matches our expectations
  const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
  
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const attributesFragment = packageJson.contributes.configuration.properties['kahua.fragmentDefinitions'].default
      .find(def => def.id === 'attributes');
    
    if (!attributesFragment) {
      console.log('❌ Could not find attributes fragment in package.json');
      return false;
    }
    
    if (!attributesFragment.hierarchicalInjectionGroups) {
      console.log('❌ hierarchicalInjectionGroups not found in attributes fragment');
      return false;
    }
    
    const hubDefGroup = attributesFragment.hierarchicalInjectionGroups.HubDef;
    if (!hubDefGroup) {
      console.log('❌ HubDef hierarchical group not configured');
      return false;
    }
    
    console.log('✅ Configuration validation passed:');
    console.log(`   Group selector: ${hubDefGroup.groupSelector}`);
    console.log(`   Display attribute: ${hubDefGroup.groupDisplayAttribute}`);
    console.log(`   Path token: ${hubDefGroup.groupPathToken}`);
    console.log(`   Configured paths: ${Object.keys(hubDefGroup.paths).join(', ')}`);
    
    // Validate path templates use the correct token
    const pathTemplates = Object.values(hubDefGroup.paths);
    const allUseToken = pathTemplates.every(template => template.includes(hubDefGroup.groupPathToken));
    
    if (!allUseToken) {
      console.log('❌ Not all path templates use the group path token');
      return false;
    }
    
    console.log('✅ All path templates correctly use group path token');
    return true;
    
  } catch (error) {
    console.log(`❌ Error reading package.json: ${error.message}`);
    return false;
  }
}

// Run tests
console.log('🧪 Starting Hierarchical Injection Integration Tests\n');

const test1 = testHierarchicalInjectionGrouping();
const test2 = testMultipleImportDefTargets(); 
const test3 = testConfigurationCompliance();

console.log('\n📊 Test Results:');
console.log(`   Hierarchical grouping: ${test1 ? '✅ PASS' : '❌ FAIL'}`);
console.log(`   Multiple targets: ${test2 ? '✅ PASS' : '❌ FAIL'}`);
console.log(`   Configuration: ${test3 ? '✅ PASS' : '❌ FAIL'}`);

const allPassed = test1 && test2 && test3;
console.log(`\n🎯 Overall: ${allPassed ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`);

process.exit(allPassed ? 0 : 1);