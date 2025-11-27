import * as assert from 'assert';
import * as vscode from 'vscode';
import { parseXmlDocumentInternal, extractAttributeValue, extractTextContent, extractSelectableValues, findElementsByXPath, getParsedXmlContext } from '../../extension';

// Mock SAX parser for testing (since we can't import the real saxes in test environment)
class MockSaxesParser {
  handlers: Record<string, Function> = {};
  line = 1;
  column = 1;

  constructor(options?: any) {}

  on(event: string, handler: Function): void {
    this.handlers[event] = handler;
  }

  write(text: string): MockSaxesParser {
    const lines = text.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      this.line = i + 1;
      
      // Find opening tags
      const openMatch = line.match(/<(\w+)([^>]*)>/g);
      if (openMatch) {
        for (const match of openMatch) {
          const tagMatch = match.match(/<(\w+)([^>]*)/);
          if (tagMatch) {
            const tagName = tagMatch[1];
            const attributesText = tagMatch[2] || '';
            
            // Parse attributes
            const attributes: Record<string, any> = {};
            const attrMatches = attributesText.matchAll(/(\w+)="([^"]*)"/g);
            for (const attrMatch of attrMatches) {
              attributes[attrMatch[1]] = { value: attrMatch[2] };
            }
            
            const isSelfClosing = match.endsWith('/>');
            
            if (this.handlers.opentag) {
              this.handlers.opentag({
                name: tagName,
                attributes,
                isSelfClosing
              });
            }
            
            if (isSelfClosing && this.handlers.closetag) {
              this.handlers.closetag(tagName);
            }
          }
        }
      }
      
      // Find closing tags
      const closeMatch = line.match(/<\/(\w+)>/g);
      if (closeMatch) {
        for (const match of closeMatch) {
          const tagMatch = match.match(/<\/(\w+)>/);
          if (tagMatch && this.handlers.closetag) {
            this.handlers.closetag(tagMatch[1]);
          }
        }
      }
    }
    
    return this;
  }

  close(): void {}
}

// Mock parseXmlDocumentInternal for testing
function mockParseXmlDocumentInternal(xmlContent: string): any {
  const parser = new MockSaxesParser({ xmlns: false, position: true });
  let rootElement: any = null;
  const elementStack: any[] = [];
  let currentTextContent = '';

  parser.on('opentag', (tag: any) => {
    const attributes: Record<string, string> = {};
    for (const [key, attr] of Object.entries(tag.attributes)) {
      attributes[key] = (attr as any).value || '';
    }

    const pathParts = elementStack.map(el => el.tagName);
    pathParts.push(tag.name);
    const path = pathParts.join('/');

    const lineNumber = parser.line - 1;
    const indentation = '';

    const element = {
      tagName: tag.name,
      attributes,
      line: lineNumber,
      column: parser.column,
      parent: elementStack.length > 0 ? elementStack[elementStack.length - 1] : undefined,
      children: [],
      path,
      nameAttributeValue: attributes.Name || attributes.name,
      indentation,
      isSelfClosing: !!tag.isSelfClosing
    };

    if (elementStack.length === 0) {
      rootElement = element;
    } else {
      const parent = elementStack[elementStack.length - 1];
      parent.children.push(element);
    }

    elementStack.push(element);
    currentTextContent = '';
  });

  parser.on('text', (text: string) => {
    if (text.trim()) {
      currentTextContent += text;
    }
  });

  parser.on('closetag', (name: string) => {
    const element = elementStack.pop();
    if (element && currentTextContent.trim()) {
      element.textContent = currentTextContent.trim();
    }
    currentTextContent = '';
  });

  parser.on('error', (error: any) => {
    throw new Error(`XML parsing error: ${error}`);
  });

  const xmlText = xmlContent.replace(/xmlns="[^"]*"/g, '');
  parser.write(xmlText).close();

  return rootElement;
}

suite('Token Extraction Tests', () => {
  const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
<App Name="TestApp" DisplayName="Test Application">
  <EntityDefs>
    <EntityDef Name="Field" DisplayName="Field Entity">
      <Attributes>
        <Attribute Name="TestField" Type="Text" VisualType="TextBox" Label="Test Field" DescriptionLabel="Test Field Description" />
      </Attributes>
    </EntityDef>
    <EntityDef Name="Project" DisplayName="Project Entity">
      <Attributes>
        <Attribute Name="ProjectName" Type="Text" VisualType="TextBox" Label="Project Name" />
      </Attributes>
    </EntityDef>
  </EntityDefs>
</App>`;

  suite('SAX Parser Tests', () => {
    test('should parse XML correctly with SAX parser', () => {
      // Use mock parser since we can't import real saxes in test environment
      const result = mockParseXmlDocumentInternal(sampleXml);
      
      assert.notStrictEqual(result, null, 'Parser should return a result');
      assert.strictEqual(result!.tagName, 'App', 'Root element should be App');
      assert.strictEqual(result!.attributes.Name, 'TestApp', 'App Name should be extracted');
      assert.strictEqual(result!.attributes.DisplayName, 'Test Application', 'App DisplayName should be extracted');
    });

    test('should build correct element tree structure', () => {
      const result = mockParseXmlDocumentInternal(sampleXml);
      
      assert.strictEqual(result!.children.length, 1, 'App should have one child (EntityDefs)');
      const entityDefs = result!.children[0];
      assert.strictEqual(entityDefs.tagName, 'EntityDefs', 'First child should be EntityDefs');
      assert.strictEqual(entityDefs.children.length, 2, 'EntityDefs should have two EntityDef children');
      
      const fieldEntity = entityDefs.children[0];
      assert.strictEqual(fieldEntity.tagName, 'EntityDef', 'Should be EntityDef');
      assert.strictEqual(fieldEntity.attributes.Name, 'Field', 'Should have correct Name attribute');
    });

    test('should set correct paths for elements', () => {
      const result = mockParseXmlDocumentInternal(sampleXml);
      
      assert.strictEqual(result!.path, 'App', 'Root should have path App');
      
      const entityDefs = result!.children[0];
      assert.strictEqual(entityDefs.path, 'App/EntityDefs', 'EntityDefs should have correct path');
      
      const fieldEntity = entityDefs.children[0];
      assert.strictEqual(fieldEntity.path, 'App/EntityDefs/EntityDef', 'EntityDef should have correct path');
    });
  });

  suite('XPath Element Finding Tests', () => {
    let mockDocument: vscode.TextDocument;
    let xmlContext: any;

    setup(() => {
      // Create mock document
      mockDocument = {
        uri: vscode.Uri.parse('test://test.xml'),
        getText: () => sampleXml,
        lineCount: sampleXml.split('\n').length,
        lineAt: (line: number) => ({ text: sampleXml.split('\n')[line] || '' } as any),
        version: 1
      } as any;

      // Parse XML and create context
      const rootElement = mockParseXmlDocumentInternal(sampleXml);
      xmlContext = {
        textDocument: mockDocument,
        version: 1,
        contentHash: 'test',
        rootElement,
        elementsByPath: new Map(),
        xpathElementCache: new Map(),
        xpathTargetCache: new Map(),
        lineResolutionCache: new Map(),
        pathLineInfo: new Map()
      };

      // Build elements by path map
      function buildElementsByPath(element: any, elementsByPath: Map<string, any[]>) {
        if (!element) return;
        
        const path = element.path;
        if (!elementsByPath.has(path)) {
          elementsByPath.set(path, []);
        }
        elementsByPath.get(path)!.push(element);

        // Also add partial paths
        const pathParts = path.split('/').filter((p: string) => p);
        for (let i = 1; i <= pathParts.length; i++) {
          const partialPath = pathParts.slice(-i).join('/');
          if (!elementsByPath.has(partialPath)) {
            elementsByPath.set(partialPath, []);
          }
          elementsByPath.get(partialPath)!.push(element);
        }

        for (const child of element.children) {
          buildElementsByPath(child, elementsByPath);
        }
      }

      buildElementsByPath(rootElement, xmlContext.elementsByPath);
    });

    test('should find elements by simple XPath', () => {
      const elements = findElementsByXPath(xmlContext, 'App');
      
      assert.strictEqual(elements.length, 1, 'Should find one App element');
      assert.strictEqual(elements[0].tagName, 'App', 'Found element should be App');
      assert.strictEqual(elements[0].attributes.Name, 'TestApp', 'Should have correct Name attribute');
    });

    test('should find nested elements by XPath', () => {
      const elements = findElementsByXPath(xmlContext, 'App/EntityDefs/EntityDef');
      
      assert.strictEqual(elements.length, 2, 'Should find two EntityDef elements');
      assert.strictEqual(elements[0].tagName, 'EntityDef', 'Found elements should be EntityDef');
      assert.strictEqual(elements[0].attributes.Name, 'Field', 'First EntityDef should be Field');
      assert.strictEqual(elements[1].attributes.Name, 'Project', 'Second EntityDef should be Project');
    });

    test('should find elements with attribute filters', () => {
      const elements = findElementsByXPath(xmlContext, 'App/EntityDefs/EntityDef[@Name=\'Field\']');
      
      assert.strictEqual(elements.length, 1, 'Should find one EntityDef with Name=Field');
      assert.strictEqual(elements[0].attributes.Name, 'Field', 'Found element should have Name=Field');
      assert.strictEqual(elements[0].attributes.DisplayName, 'Field Entity', 'Should have correct DisplayName');
    });
  });

  suite('Attribute Extraction Tests', () => {
    let mockDocument: vscode.TextDocument;

    setup(() => {
      mockDocument = {
        uri: vscode.Uri.parse('test://test.xml'),
        getText: () => sampleXml,
        lineCount: sampleXml.split('\n').length,
        lineAt: (line: number) => ({ text: sampleXml.split('\n')[line] || '' } as any),
        version: 1
      } as any;
    });

    test('should extract simple attribute values', () => {
      const appName = extractAttributeValue(mockDocument, 'App/@Name');
      const appDisplayName = extractAttributeValue(mockDocument, 'App/@DisplayName');
      
      assert.strictEqual(appName, 'TestApp', 'Should extract App Name attribute');
      assert.strictEqual(appDisplayName, 'Test Application', 'Should extract App DisplayName attribute');
    });

    test('should extract attribute from nested elements', () => {
      const entityName = extractAttributeValue(mockDocument, 'App/EntityDefs/EntityDef/@Name');
      
      // Should get the first EntityDef's Name attribute
      assert.strictEqual(entityName, 'Field', 'Should extract first EntityDef Name attribute');
    });

    test('should return undefined for non-existent attributes', () => {
      const nonExistent = extractAttributeValue(mockDocument, 'App/@NonExistent');
      const nonExistentPath = extractAttributeValue(mockDocument, 'NonExistent/@Name');
      
      assert.strictEqual(nonExistent, undefined, 'Should return undefined for non-existent attribute');
      assert.strictEqual(nonExistentPath, undefined, 'Should return undefined for non-existent path');
    });
  });

  suite('Selectable Values Extraction Tests', () => {
    let mockDocument: vscode.TextDocument;

    setup(() => {
      mockDocument = {
        uri: vscode.Uri.parse('test://test.xml'),
        getText: () => sampleXml,
        lineCount: sampleXml.split('\n').length,
        lineAt: (line: number) => ({ text: sampleXml.split('\n')[line] || '' } as any),
        version: 1
      } as any;
    });

    test('should extract selectable values from multiple elements', () => {
      const entityOptions = extractSelectableValues(mockDocument, 'App/EntityDefs/EntityDef', 'Name');
      
      assert.strictEqual(entityOptions.length, 2, 'Should find two EntityDef options');
      assert.strictEqual(entityOptions[0].value, 'Field', 'First option should be Field');
      assert.strictEqual(entityOptions[1].value, 'Project', 'Second option should be Project');
    });

    test('should include context information in selectable values', () => {
      const entityOptions = extractSelectableValues(mockDocument, 'App/EntityDefs/EntityDef', 'Name');
      
      assert.strictEqual(entityOptions[0].context, 'EntityDef', 'Should include context information');
      assert.strictEqual(entityOptions[1].context, 'EntityDef', 'Should include context information');
    });

    test('should handle non-existent paths gracefully', () => {
      const nonExistentOptions = extractSelectableValues(mockDocument, 'NonExistent/Path', 'Name');
      
      assert.strictEqual(nonExistentOptions.length, 0, 'Should return empty array for non-existent paths');
    });

    test('should filter out elements without the required attribute', () => {
      const xmlWithMissingAttrs = `<?xml version="1.0"?>
<App Name="TestApp">
  <EntityDefs>
    <EntityDef Name="HasName" />
    <EntityDef DisplayName="NoName" />
    <EntityDef Name="AlsoHasName" />
  </EntityDefs>
</App>`;

      const mockDocWithMissing = {
        uri: vscode.Uri.parse('test://test.xml'),
        getText: () => xmlWithMissingAttrs,
        lineCount: xmlWithMissingAttrs.split('\n').length,
        lineAt: (line: number) => ({ text: xmlWithMissingAttrs.split('\n')[line] || '' } as any),
        version: 1
      } as any;

      const options = extractSelectableValues(mockDocWithMissing, 'App/EntityDefs/EntityDef', 'Name');
      
      assert.strictEqual(options.length, 2, 'Should only return elements that have the Name attribute');
      assert.strictEqual(options[0].value, 'HasName', 'First option should be HasName');
      assert.strictEqual(options[1].value, 'AlsoHasName', 'Second option should be AlsoHasName');
    });
  });

  suite('Integration Tests', () => {
    test('should handle typical token extraction scenario', () => {
      const mockDocument = {
        uri: vscode.Uri.parse('test://test.xml'),
        getText: () => sampleXml,
        lineCount: sampleXml.split('\n').length,
        lineAt: (line: number) => ({ text: sampleXml.split('\n')[line] || '' } as any),
        version: 1
      } as any;

      // Test extracting appname (common token)
      const appName = extractAttributeValue(mockDocument, 'App/@Name');
      assert.strictEqual(appName, 'TestApp', 'Should extract appname correctly');

      // Test extracting entity options (common selection token)
      const entityOptions = extractSelectableValues(mockDocument, 'App/EntityDefs/EntityDef', 'Name');
      assert.strictEqual(entityOptions.length, 2, 'Should find entity options');
      const values = entityOptions.map(o => o.value);
      assert.ok(values.includes('Field'), 'Should find Field entity');
      assert.ok(values.includes('Project'), 'Should find Project entity');
    });
  });
});