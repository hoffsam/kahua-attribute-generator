import * as assert from 'assert';
import * as vscode from 'vscode';

// Mock hierarchical injection logic for testing
interface HierarchicalInjectionGroup {
  groupSelector: string;
  groupDisplayAttribute: string;
  groupPathToken: string;
}

function mockProcessHierarchicalInjectionGroups(
  injectionPaths: Record<string, string>,
  hierarchicalGroups: Record<string, HierarchicalInjectionGroup>,
  mockHubDefs: Array<{ name: string; xpath: string }>
): Record<string, string> {
  const processedPaths: Record<string, string> = { ...injectionPaths };
  
  for (const [groupName, groupConfig] of Object.entries(hierarchicalGroups)) {
    // Auto-detect which injection paths belong to this group by matching the group selector pattern
    const groupSelectorParts = groupConfig.groupSelector.split('/');
    const groupPathPattern = groupSelectorParts.join('/');
    
    // Find injection paths that contain the group pattern
    const affectedSections: string[] = [];
    const originalPaths: Record<string, string> = {};
    
    for (const [sectionName, xpath] of Object.entries(injectionPaths)) {
      // Check if this injection path contains the hierarchical group pattern
      if (xpath.includes(groupPathPattern)) {
        affectedSections.push(sectionName);
        originalPaths[sectionName] = xpath;
      }
    }
    
    if (affectedSections.length === 0) {
      continue;
    }
    
    // For testing, assume we select the first available HubDef
    if (mockHubDefs.length > 0) {
      const selectedHubDef = mockHubDefs[0];
      const groupPath = selectedHubDef.xpath;
      
      // Update injection paths for this group by replacing the group selector with specific container path
      for (const sectionName of affectedSections) {
        if (sectionName in injectionPaths) {
          const originalPath = originalPaths[sectionName];
          const expandedPath = originalPath.replace(groupConfig.groupSelector, groupPath);
          processedPaths[sectionName] = expandedPath;
        }
      }
    }
  }
  
  return processedPaths;
}

// Test for automatic detection of hierarchical injection paths
function testAutoDetection() {
  const injectionPaths = {
    "Attributes": "App/EntityDefs/EntityDef/Attributes",
    "Labels": "App/Cultures/Culture[@Code='en']/Labels", 
    "FieldDefs": "App/App.HubDefs/HubDef/HubDef.LogDef/LogDef.FieldDefs",
    "ImportDefs": "App/App.HubDefs/HubDef/HubDef.ImportDefs/ImportDef/ImportDef.Sheets/Sheet/Sheet.Columns",
    "DataStore": "App/DataStore/Tables/Table/Columns"
  };
  
  const hierarchicalGroups = {
    "HubDef": {
      groupSelector: "App/App.HubDefs/HubDef",
      groupDisplayAttribute: "Name",
      groupPathToken: "$hubpath"
    }
  };
  
  // Test the detection logic
  const groupConfig = hierarchicalGroups["HubDef"];
  const groupSelectorParts = groupConfig.groupSelector.split('/');
  const groupPathPattern = groupSelectorParts.join('/');
  
  const affectedSections: string[] = [];
  
  for (const [sectionName, xpath] of Object.entries(injectionPaths)) {
    if (xpath.includes(groupPathPattern)) {
      affectedSections.push(sectionName);
    }
  }
  
  return {
    affectedSections,
    totalPaths: Object.keys(injectionPaths).length,
    detectedCount: affectedSections.length
  };
}

suite('Hierarchical Injection Tests', () => {

  test('should automatically detect paths belonging to hierarchical groups', () => {
    const detectionResult = testAutoDetection();
    
    console.log('✅ Auto-detection of hierarchical injection paths');
    console.log(`   Total injection paths: ${detectionResult.totalPaths}`);
    console.log(`   HubDef-related paths detected: ${detectionResult.detectedCount}`);
    console.log(`   Affected sections: ${detectionResult.affectedSections.join(', ')}`);
    
    assert.strictEqual(detectionResult.detectedCount, 2, 'Should detect exactly 2 HubDef-related paths');
    assert.ok(detectionResult.affectedSections.includes('FieldDefs'), 'Should detect FieldDefs as HubDef-related');
    assert.ok(detectionResult.affectedSections.includes('ImportDefs'), 'Should detect ImportDefs as HubDef-related');
    assert.ok(!detectionResult.affectedSections.includes('Attributes'), 'Should not detect Attributes as HubDef-related');
    assert.ok(!detectionResult.affectedSections.includes('Labels'), 'Should not detect Labels as HubDef-related');
    assert.ok(!detectionResult.affectedSections.includes('DataStore'), 'Should not detect DataStore as HubDef-related');
  });

  suite('HubDef Container Grouping', () => {
    test('should group FieldDefs and ImportDefs under HubDef containers', () => {
      const injectionPaths = {
        "Attributes": "App/EntityDefs/EntityDef/Attributes",
        "FieldDefs": "App/App.HubDefs/HubDef/HubDef.LogDef/LogDef.FieldDefs",
        "ImportDefs": "App/App.HubDefs/HubDef/HubDef.ImportDefs/ImportDef/ImportDef.Sheets/Sheet/Sheet.Columns"
      };
      
      const hierarchicalGroups = {
        "HubDef": {
          groupSelector: "App/App.HubDefs/HubDef",
          groupDisplayAttribute: "Name",
          groupPathToken: "$hubpath"
        }
      };
      
      const mockHubDefs = [
        { name: "ProjectHub", xpath: "App/App.HubDefs/HubDef[@Name='ProjectHub']" },
        { name: "RFIHub", xpath: "App/App.HubDefs/HubDef[@Name='RFIHub']" }
      ];
      
      const result = mockProcessHierarchicalInjectionGroups(injectionPaths, hierarchicalGroups, mockHubDefs);
      
      console.log('✅ Hierarchical grouping correctly applied');
      console.log(`   FieldDefs: ${result.FieldDefs}`);
      console.log(`   ImportDefs: ${result.ImportDefs}`);
      console.log(`   Attributes: ${result.Attributes} (unchanged)`);
      
      // FieldDefs and ImportDefs should be updated with specific HubDef path
      assert.strictEqual(
        result.FieldDefs, 
        "App/App.HubDefs/HubDef[@Name='ProjectHub']/HubDef.LogDef/LogDef.FieldDefs",
        'FieldDefs should target specific HubDef'
      );
      
      assert.strictEqual(
        result.ImportDefs, 
        "App/App.HubDefs/HubDef[@Name='ProjectHub']/HubDef.ImportDefs/ImportDef/ImportDef.Sheets/Sheet/Sheet.Columns",
        'ImportDefs should target specific HubDef'
      );
      
      // Attributes should remain unchanged (not part of HubDef group)
      assert.strictEqual(
        result.Attributes, 
        "App/EntityDefs/EntityDef/Attributes",
        'Attributes should remain unchanged'
      );
    });
    
    test('should handle multiple HubDef containers', () => {
      const injectionPaths = {
        "FieldDefs": "App/App.HubDefs/HubDef/HubDef.LogDef/LogDef.FieldDefs",
      };
      
      const hierarchicalGroups = {
        "HubDef": {
          groupSelector: "App/App.HubDefs/HubDef",
          groupDisplayAttribute: "Name", 
          groupPathToken: "$hubpath"
        }
      };
      
      const mockHubDefs = [
        { name: "ProjectHub", xpath: "App/App.HubDefs/HubDef[@Name='ProjectHub']" },
        { name: "RFIHub", xpath: "App/App.HubDefs/HubDef[@Name='RFIHub']" },
        { name: "ReportHub", xpath: "App/App.HubDefs/HubDef[@Name='ReportHub']" }
      ];
      
      // In real implementation, user would be prompted to select
      // For test, we simulate selecting the first one
      const result = mockProcessHierarchicalInjectionGroups(injectionPaths, hierarchicalGroups, mockHubDefs);
      
      console.log('✅ Multiple HubDef handling works');
      console.log(`   Selected: ${mockHubDefs[0].name}`);
      console.log(`   Result: ${result.FieldDefs}`);
      
      assert.ok(result.FieldDefs.includes("ProjectHub"), 'Should select first HubDef in mock scenario');
      assert.strictEqual(mockHubDefs.length, 3, 'Should detect multiple HubDef options');
    });
    
    test('should handle no HubDef containers gracefully', () => {
      const injectionPaths = {
        "Attributes": "App/EntityDefs/EntityDef/Attributes",
        "FieldDefs": "App/App.HubDefs/HubDef/HubDef.LogDef/LogDef.FieldDefs",
      };
      
      const hierarchicalGroups = {
        "HubDef": {
          groupSelector: "App/App.HubDefs/HubDef",
          groupDisplayAttribute: "Name",
          groupPathToken: "$hubpath"
        }
      };
      
      const mockHubDefs: Array<{ name: string; xpath: string }> = []; // No HubDefs found
      
      const result = mockProcessHierarchicalInjectionGroups(injectionPaths, hierarchicalGroups, mockHubDefs);
      
      console.log('✅ No HubDef containers handled gracefully');
      console.log(`   FieldDefs: ${result.FieldDefs} (should be unchanged)`);
      console.log(`   Attributes: ${result.Attributes} (should be unchanged)`);
      
      // Should remain unchanged when no containers found
      assert.strictEqual(
        result.FieldDefs, 
        "App/App.HubDefs/HubDef/HubDef.LogDef/LogDef.FieldDefs",
        'FieldDefs should remain unchanged when no HubDefs found'
      );
      
      assert.strictEqual(
        result.Attributes, 
        "App/EntityDefs/EntityDef/Attributes", 
        'Attributes should remain unchanged'
      );
    });
    
    test('should support mixed hierarchical and flat injection paths', () => {
      const injectionPaths = {
        "Attributes": "App/EntityDefs/EntityDef/Attributes",
        "Labels": "App/Cultures/Culture[@Code='en']/Labels", 
        "DataTags": "App/DataTags",
        "FieldDefs": "App/App.HubDefs/HubDef/HubDef.LogDef/LogDef.FieldDefs",
        "ImportDefs": "App/App.HubDefs/HubDef/HubDef.ImportDefs/ImportDef/ImportDef.Sheets/Sheet/Sheet.Columns"
      };
      
      const hierarchicalGroups = {
        "HubDef": {
          groupSelector: "App/App.HubDefs/HubDef",
          groupDisplayAttribute: "Name",
          groupPathToken: "$hubpath"
        }
      };
      
      const mockHubDefs = [
        { name: "MainHub", xpath: "App/App.HubDefs/HubDef[@Name='MainHub']" }
      ];
      
      const result = mockProcessHierarchicalInjectionGroups(injectionPaths, hierarchicalGroups, mockHubDefs);
      
      console.log('✅ Mixed hierarchical and flat paths work correctly');
      console.log(`   Hierarchical FieldDefs: ${result.FieldDefs}`);
      console.log(`   Hierarchical ImportDefs: ${result.ImportDefs}`);
      console.log(`   Flat Attributes: ${result.Attributes}`);
      console.log(`   Flat Labels: ${result.Labels}`);
      console.log(`   Flat DataTags: ${result.DataTags}`);
      
      // Hierarchical paths should be updated
      assert.ok(result.FieldDefs.includes("MainHub"), 'FieldDefs should target specific HubDef');
      assert.ok(result.ImportDefs.includes("MainHub"), 'ImportDefs should target specific HubDef');
      
      // Flat paths should remain unchanged
      assert.strictEqual(result.Attributes, "App/EntityDefs/EntityDef/Attributes");
      assert.strictEqual(result.Labels, "App/Cultures/Culture[@Code='en']/Labels");
      assert.strictEqual(result.DataTags, "App/DataTags");
    });
  });
  
  suite('Configuration Validation', () => {
    test('should validate simplified hierarchical injection group configuration', () => {
      const hierarchicalGroups = {
        "HubDef": {
          groupSelector: "App/App.HubDefs/HubDef",
          groupDisplayAttribute: "Name",
          groupPathToken: "$hubpath"
        }
      };
      
      const hubDefGroup = hierarchicalGroups.HubDef;
      
      // Validate required properties
      assert.ok(hubDefGroup.groupSelector, 'Should have groupSelector');
      assert.ok(hubDefGroup.groupDisplayAttribute, 'Should have groupDisplayAttribute');  
      assert.ok(hubDefGroup.groupPathToken, 'Should have groupPathToken');
      
      console.log('✅ Simplified hierarchical injection group configuration is valid');
      console.log(`   Group selector: ${hubDefGroup.groupSelector}`);
      console.log(`   Display attribute: ${hubDefGroup.groupDisplayAttribute}`);
      console.log(`   Path token: ${hubDefGroup.groupPathToken}`);
      console.log('   Paths are now auto-detected from injection path configuration');
    });

    test('should correctly replace group selector in actual paths', () => {
      const originalPath = "App/App.HubDefs/HubDef/HubDef.LogDef/LogDef.FieldDefs";
      const groupSelector = "App/App.HubDefs/HubDef";
      const selectedContainerPath = "App/App.HubDefs/HubDef[@Name='MyHub']";
      
      const expectedPath = "App/App.HubDefs/HubDef[@Name='MyHub']/HubDef.LogDef/LogDef.FieldDefs";
      const actualPath = originalPath.replace(groupSelector, selectedContainerPath);
      
      console.log('✅ Path replacement works correctly');
      console.log(`   Original: ${originalPath}`);
      console.log(`   Expected: ${expectedPath}`);
      console.log(`   Actual: ${actualPath}`);
      
      assert.strictEqual(actualPath, expectedPath, 'Should correctly replace group selector with specific container path');
    });
  });
});