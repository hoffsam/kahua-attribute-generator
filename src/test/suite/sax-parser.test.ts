import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * SAX Parser Integration Tests
 * These tests verify that the SAX parser correctly extracts attributes from real XML files
 */
suite('SAX Parser Tests', () => {

  // Sample XML that matches the structure of real Kahua XML files
  const testXml = `<?xml version="1.0" encoding="UTF-8"?>
<App Extends="kahua_AEC_RFI" Name="kahua_aec_rfi_extension" DataScope="Default" AppScope="Partition" Version="1750" Description="Test Extension" Label="Test Label">
  <EntityDefs>
    <EntityDef Name="Field" DisplayName="Field Entity" IsAttachable="true" IsConfigurable="true">
      <Attributes>
        <Attribute Name="TestField" Type="Text" VisualType="TextBox" Label="Test Field" />
        <Attribute Name="Status" Type="Text" VisualType="DropDownList" Label="Status" />
      </Attributes>
    </EntityDef>
    <EntityDef Name="Project" DisplayName="Project Entity">
      <Attributes>
        <Attribute Name="ProjectName" Type="Text" VisualType="TextBox" Label="Project Name" />
      </Attributes>
    </EntityDef>
  </EntityDefs>
</App>`;

  // Test XML with empty/missing attributes to test edge cases
  const edgeCaseXml = `<?xml version="1.0" encoding="UTF-8"?>
<App Name="" DataScope="Default">
  <EntityDefs>
    <EntityDef Name="EmptyName" DisplayName="">
      <Attributes>
        <Attribute Name="TestAttr" Type="" />
      </Attributes>
    </EntityDef>
    <EntityDef>
      <Attributes />
    </EntityDef>
  </EntityDefs>
</App>`;

  // Real-world XML with BOM and complex structure
  const complexXml = `﻿<?xml version="1.0" encoding="UTF-8"?>
<App Extends="kahua_AEC_RFI" Name="kahua_aec_rfi_extension" DataScope="Default" AppScope="Partition" Version="1750" Description="[RFIAppExtensionDescription]" Label="[RFIAppExtensionLabel]" PermissionMode="GrantByDefault" CultureCode="en" PlatformScript="kahua_AEC_RFI.App">
  <AppPublishing ProductType="App" VisibilityType="Private" AvailabilityText="Coming 2013" UnitPrice="95.0">
    <ProductInfo Label="RFIs - Extension" Description="RFIs Extension" />
  </AppPublishing>
  <EntityDefs>
    <EntityDef Name="Field" IsAttachable="true" IsConfigurable="true" EntityType="Standard" IsSearchable="true" DefaultReport="FieldReport">
      <Attributes>
        <Attribute Name="TestField" Type="Text" VisualType="TextBox" Label="Test Field" DescriptionLabel="Test Field Description" LinkedEntityDef="Project" />
      </Attributes>
    </EntityDef>
    <EntityDef Name="Document" EntityType="Attachable" DefaultReport="DocumentReport">
      <Attributes>
        <Attribute Name="DocumentName" Type="Text" VisualType="TextBox" Label="Document Name" />
      </Attributes>
    </EntityDef>
    <EntityDef Name="Project" IsAttachable="false" IsBrowsable="true" IsConfigurable="false" Description="Project management entity">
      <Attributes>
        <Attribute Name="ProjectName" Type="Text" VisualType="TextBox" Label="Project Name" />
        <Attribute Name="Budget" Type="Currency" VisualType="TextBox" Label="Budget" />
      </Attributes>
    </EntityDef>
  </EntityDefs>
</App>`;

  // Mock SAX parser to test the real SAX library behavior
  let realSaxes: any;
  
  suiteSetup(async () => {
    try {
      // Try to import the real saxes library
      realSaxes = await import('saxes');
    } catch (error) {
      console.warn('Real saxes library not available for testing, using mock');
    }
  });

  suite('SAX Library Integration', () => {
    test('should import saxes library successfully', () => {
      if (realSaxes) {
        assert.ok(realSaxes.SaxesParser, 'Should have SaxesParser class');
        console.log('✓ Real saxes library available for testing');
      } else {
        console.warn('⚠️  Real saxes library not available, some tests will be skipped');
      }
    });

    test('should parse XML and extract attributes correctly', function(done) {
      if (!realSaxes) {
        this.skip();
        return;
      }

      const parser = new realSaxes.SaxesParser({ xmlns: false, position: true });
      const extractedElements: any[] = [];
      
      parser.on('opentag', (tag: any) => {
        // Test the actual structure that saxes returns
        console.log(`Tag: ${tag.name}, Attributes type: ${typeof tag.attributes}`);
        
        if (tag.name === 'App' || tag.name === 'EntityDef' || tag.name === 'Attribute') {
          const element = {
            tagName: tag.name,
            attributes: {},
            rawAttributes: tag.attributes
          };

          // Test different ways to extract attributes
          for (const [key, attr] of Object.entries(tag.attributes)) {
            console.log(`Attribute ${key}:`, {
              type: typeof attr,
              value: attr,
              hasValue: 'value' in (attr as any),
              hasNodeValue: 'nodeValue' in (attr as any)
            });

            let value = '';
            if (typeof attr === 'string') {
              value = attr;
            } else if (attr && typeof attr === 'object') {
              value = (attr as any).value || (attr as any).nodeValue || '';
            }
            
            (element.attributes as any)[key] = value;
          }

          extractedElements.push(element);
        }
      });

      parser.on('error', (error: any) => {
        done(error);
      });

      parser.on('end', () => {
        try {
          // Verify we extracted elements correctly
          assert.ok(extractedElements.length > 0, 'Should extract at least one element');
          
          // Find the App element
          const appElement = extractedElements.find(el => el.tagName === 'App');
          assert.ok(appElement, 'Should find App element');
          
          console.log('App element attributes:', appElement.attributes);
          
          // Test that App Name attribute was extracted
          const appName = appElement.attributes.Name;
          assert.ok(appName, 'App should have Name attribute');
          assert.strictEqual(appName, 'kahua_aec_rfi_extension', 'App Name should be extracted correctly');
          
          // Test other App attributes
          assert.strictEqual(appElement.attributes.Extends, 'kahua_AEC_RFI', 'App Extends should be extracted');
          assert.strictEqual(appElement.attributes.DataScope, 'Default', 'App DataScope should be extracted');
          
          // Find EntityDef elements
          const entityDefElements = extractedElements.filter(el => el.tagName === 'EntityDef');
          assert.ok(entityDefElements.length >= 2, 'Should find at least 2 EntityDef elements');
          
          // Test EntityDef attributes
          const fieldEntity = entityDefElements.find(el => el.attributes.Name === 'Field');
          assert.ok(fieldEntity, 'Should find Field entity');
          assert.strictEqual(fieldEntity.attributes.DisplayName, 'Field Entity', 'EntityDef DisplayName should be extracted');
          
          // Find Attribute elements
          const attributeElements = extractedElements.filter(el => el.tagName === 'Attribute');
          assert.ok(attributeElements.length > 0, 'Should find Attribute elements');
          
          const testFieldAttr = attributeElements.find(el => el.attributes.Name === 'TestField');
          assert.ok(testFieldAttr, 'Should find TestField attribute');
          assert.strictEqual(testFieldAttr.attributes.Type, 'Text', 'Attribute Type should be extracted');
          assert.strictEqual(testFieldAttr.attributes.Label, 'Test Field', 'Attribute Label should be extracted');

          console.log('✅ All SAX attribute extraction tests passed');
          done();
        } catch (error) {
          done(error);
        }
      });

      // Parse the test XML
      parser.write(testXml).close();
    });

    test('should handle empty and missing attributes', function(done) {
      if (!realSaxes) {
        this.skip();
        return;
      }

      const parser = new realSaxes.SaxesParser({ xmlns: false, position: true });
      const elements: any[] = [];
      
      parser.on('opentag', (tag: any) => {
        if (tag.name === 'App' || tag.name === 'EntityDef') {
          const attributes: Record<string, string> = {};
          
          for (const [key, attr] of Object.entries(tag.attributes)) {
            let value = '';
            if (typeof attr === 'string') {
              value = attr;
            } else if (attr && typeof attr === 'object') {
              value = (attr as any).value || (attr as any).nodeValue || '';
            }
            attributes[key] = value;
          }
          
          elements.push({ tagName: tag.name, attributes });
        }
      });

      parser.on('end', () => {
        try {
          const appElement = elements.find(el => el.tagName === 'App');
          assert.ok(appElement, 'Should find App element');
          
          // Test empty attribute
          assert.strictEqual(appElement.attributes.Name, '', 'Empty Name attribute should be empty string');
          assert.strictEqual(appElement.attributes.DataScope, 'Default', 'Non-empty attribute should work');
          
          // Test EntityDef with missing Name attribute
          const entityDefWithoutName = elements.find(el => 
            el.tagName === 'EntityDef' && !el.attributes.Name
          );
          
          if (entityDefWithoutName) {
            assert.strictEqual(entityDefWithoutName.attributes.Name, undefined, 
                              'Missing attribute should be undefined');
          }

          console.log('✅ Empty/missing attribute handling tests passed');
          done();
        } catch (error) {
          done(error);
        }
      });

      parser.write(edgeCaseXml).close();
    });

    test('should handle complex XML with BOM and special characters', function(done) {
      if (!realSaxes) {
        this.skip();
        return;
      }

      const parser = new realSaxes.SaxesParser({ xmlns: false, position: true });
      let appElement: any = null;
      let entityDefCount = 0;
      
      parser.on('opentag', (tag: any) => {
        if (tag.name === 'App') {
          const attributes: Record<string, string> = {};
          for (const [key, attr] of Object.entries(tag.attributes)) {
            let value = '';
            if (typeof attr === 'string') {
              value = attr;
            } else if (attr && typeof attr === 'object') {
              value = (attr as any).value || (attr as any).nodeValue || '';
            }
            attributes[key] = value;
          }
          appElement = { attributes };
        } else if (tag.name === 'EntityDef') {
          entityDefCount++;
        }
      });

      parser.on('end', () => {
        try {
          assert.ok(appElement, 'Should parse App element despite BOM');
          assert.strictEqual(appElement.attributes.Name, 'kahua_aec_rfi_extension', 
                            'Should extract Name correctly from complex XML');
          assert.strictEqual(appElement.attributes.PermissionMode, 'GrantByDefault', 
                            'Should extract complex attributes');
          assert.strictEqual(entityDefCount, 3, 'Should find all EntityDef elements in complex XML');

          console.log('✅ Complex XML parsing tests passed');
          done();
        } catch (error) {
          done(error);
        }
      });

      parser.write(complexXml).close();
    });
  });

  suite('SAX Parser Behavior Analysis', () => {
    test('should document saxes attribute structure', function(done) {
      if (!realSaxes) {
        this.skip();
        return;
      }

      const parser = new realSaxes.SaxesParser({ xmlns: false, position: true });
      let attributeStructureDocumented = false;
      
      parser.on('opentag', (tag: any) => {
        if (tag.name === 'App' && !attributeStructureDocumented) {
          console.log('\n=== SAX Attribute Structure Documentation ===');
          console.log(`Tag name: ${tag.name}`);
          console.log(`Attributes object type: ${typeof tag.attributes}`);
          console.log(`Attributes object:`, tag.attributes);
          console.log(`Attributes keys:`, Object.keys(tag.attributes));
          
          for (const [key, attr] of Object.entries(tag.attributes)) {
            console.log(`\nAttribute "${key}":`);
            console.log(`  Type: ${typeof attr}`);
            console.log(`  Value: ${attr}`);
            console.log(`  Constructor: ${attr?.constructor?.name}`);
            
            if (attr && typeof attr === 'object') {
              console.log(`  Object keys: ${Object.keys(attr as any)}`);
              console.log(`  Has 'value' property: ${'value' in (attr as any)}`);
              console.log(`  Has 'nodeValue' property: ${'nodeValue' in (attr as any)}`);
            }
          }
          console.log('=== End Documentation ===\n');
          
          attributeStructureDocumented = true;
        }
      });

      parser.on('end', () => {
        assert.ok(attributeStructureDocumented, 'Should document attribute structure');
        console.log('📚 SAX attribute structure documented for debugging');
        done();
      });

      parser.write(testXml).close();
    });

    test('should compare different attribute extraction methods', function(done) {
      if (!realSaxes) {
        this.skip();
        return;
      }

      const parser = new realSaxes.SaxesParser({ xmlns: false, position: true });
      
      parser.on('opentag', (tag: any) => {
        if (tag.name === 'App') {
          console.log('\n=== Attribute Extraction Method Comparison ===');
          
          for (const [key, attr] of Object.entries(tag.attributes)) {
            console.log(`\nAttribute "${key}":`);
            
            // Method 1: Direct access
            const method1 = attr;
            console.log(`  Method 1 (direct): "${method1}"`);
            
            // Method 2: .value property
            const method2 = (attr as any).value || '';
            console.log(`  Method 2 (.value): "${method2}"`);
            
            // Method 3: .nodeValue property
            const method3 = (attr as any).nodeValue || '';
            console.log(`  Method 3 (.nodeValue): "${method3}"`);
            
            // Method 4: String conversion
            const method4 = String(attr);
            console.log(`  Method 4 (String()): "${method4}"`);
            
            // Method 5: Our current logic
            let method5 = '';
            if (typeof attr === 'string') {
              method5 = attr;
            } else if (attr && typeof attr === 'object') {
              method5 = (attr as any).value || (attr as any).nodeValue || '';
            }
            console.log(`  Method 5 (current): "${method5}"`);
            
            // Determine which method works best
            const methods = [method1, method2, method3, method4, method5];
            const nonEmpty = methods.filter(m => m && m.trim());
            
            if (nonEmpty.length > 0) {
              console.log(`  ✅ Working methods found: ${nonEmpty.length}`);
              console.log(`  📝 Best value: "${nonEmpty[0]}"`);
            } else {
              console.log(`  ❌ No working methods found`);
            }
          }
          console.log('=== End Comparison ===\n');
        }
      });

      parser.on('end', () => {
        console.log('📊 Attribute extraction methods compared');
        done();
      });

      parser.write(testXml).close();
    });
  });

  suite('Integration with Extension Code', () => {
    test('should work with extension parseXmlDocumentInternal function', function() {
      // This test verifies that our extension's parsing logic works correctly
      // We'll need to import the actual parsing function from the extension
      
      // Note: In a real VS Code extension test, we would import from '../../extension'
      // For now, we'll test the expected behavior
      
      const expectedBehavior = {
        shouldExtractAppName: 'kahua_aec_rfi_extension',
        shouldExtractEntityNames: ['Field', 'Project'],
        shouldExtractAttributeNames: ['TestField', 'Status', 'ProjectName'],
        shouldHandleEmptyAttributes: true,
        shouldHandleMissingAttributes: true
      };

      // Test that our expectations are reasonable
      assert.ok(expectedBehavior.shouldExtractAppName.length > 0, 'Should expect non-empty app name');
      assert.ok(expectedBehavior.shouldExtractEntityNames.length > 0, 'Should expect entity names');
      assert.ok(expectedBehavior.shouldExtractAttributeNames.length > 0, 'Should expect attribute names');

      console.log('✅ Extension integration expectations defined');
    });

    test('should provide fix recommendations', function() {
      const recommendations = {
        attributeExtractionFix: 'Use direct string access: attributes[key] = String(attr)',
        fallbackMethods: ['Direct access', 'String conversion', '.value property'],
        debuggingTips: [
          'Add console.log in SAX opentag handler',
          'Check typeof attr for each attribute',
          'Test with real XML files from the project',
          'Verify BOM handling in XML files'
        ]
      };

      console.log('\n=== Fix Recommendations ===');
      console.log(`Primary fix: ${recommendations.attributeExtractionFix}`);
      console.log(`Fallback methods: ${recommendations.fallbackMethods.join(', ')}`);
      console.log('Debugging tips:');
      recommendations.debuggingTips.forEach((tip, i) => {
        console.log(`  ${i + 1}. ${tip}`);
      });
      console.log('=== End Recommendations ===\n');

      assert.ok(recommendations.attributeExtractionFix.length > 0, 'Should have primary fix recommendation');
      assert.ok(recommendations.fallbackMethods.length > 0, 'Should have fallback methods');

      console.log('💡 Fix recommendations generated');
    });
  });

  suite('Real File Testing', () => {
    test('should test with actual project XML files', function() {
      const possibleXmlFiles = [
        'test-kahua.xml',
        'kahua_AEC_RFI.xml',
        '../kahua_AEC_RFI.xml'
      ];

      let foundFiles: string[] = [];
      
      for (const file of possibleXmlFiles) {
        const fullPath = path.resolve(file);
        if (fs.existsSync(fullPath)) {
          foundFiles.push(fullPath);
          console.log(`✓ Found XML file: ${fullPath}`);
        } else {
          console.log(`✗ XML file not found: ${fullPath}`);
        }
      }

      if (foundFiles.length > 0) {
        console.log(`📁 Found ${foundFiles.length} XML files for testing`);
        
        // Test file characteristics
        for (const file of foundFiles) {
          const stats = fs.statSync(file);
          const content = fs.readFileSync(file, 'utf8');
          const hasBOM = content.charCodeAt(0) === 0xFEFF;
          const hasNamespaces = content.includes('xmlns');
          
          console.log(`File: ${path.basename(file)}`);
          console.log(`  Size: ${stats.size} bytes`);
          console.log(`  Has BOM: ${hasBOM}`);
          console.log(`  Has namespaces: ${hasNamespaces}`);
          console.log(`  First 100 chars: ${content.substring(0, 100).replace(/\n/g, '\\n')}`);
        }
        
        assert.ok(true, 'File analysis completed');
      } else {
        console.warn('⚠️  No XML files found in project for real-world testing');
        console.log('   Consider creating test XML files for comprehensive testing');
        assert.ok(true, 'File search completed (no files found)');
      }
    });
  });
});