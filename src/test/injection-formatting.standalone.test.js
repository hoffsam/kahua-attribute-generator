/**
 * Standalone test for injection formatting (empty line) fix
 */

const assert = require('assert');

// Mock VS Code API for testing
const mockDocument = {
  lineAt: (lineNumber) => ({
    text: mockLines[lineNumber] || '',
    range: {
      start: { line: lineNumber, character: 0 },
      end: { line: lineNumber, character: mockLines[lineNumber]?.length || 0 }
    }
  })
};

let mockLines = [];
let insertedText = '';
let insertPosition = null;

const mockEditBuilder = {
  insert: (position, text) => {
    insertPosition = position;
    insertedText = text;
  }
};

// Test the injection formatting logic
function testInjectionFormatting(targetSection, indentedContent) {
  let insertPosition;
  let insertionText;

  if (targetSection.isSelfClosing) {
    insertPosition = mockDocument.lineAt(targetSection.openTagLine).range.end;
    insertionText = '\n' + indentedContent;
  } else {
    // For non-self-closing tags, insert before the closing tag
    insertPosition = mockDocument.lineAt(targetSection.closeTagLine).range.start;
    
    // Check if there's existing content between opening and closing tags
    const hasExistingContent = targetSection.lastChildLine > targetSection.openTagLine;
    
    if (hasExistingContent) {
      // There's existing content, insert after it without leading newline
      insertionText = indentedContent + '\n';
    } else {
      // Empty element, add proper formatting with newlines  
      insertionText = '\n' + indentedContent + '\n';
    }
  }

  return { insertPosition, insertionText };
}

describe('Injection Formatting (Empty Line Fix)', function() {
  beforeEach(function() {
    // Reset mocks
    mockLines = [];
    insertedText = '';
    insertPosition = null;
  });

  describe('Smart Insertion Formatting', function() {
    it('should NOT add leading newline when inserting into element with existing content', function() {
      // Mock XML structure with existing content:
      // <Attributes>
      //   <Attribute Name="Existing"/>  ← existing content
      // </Attributes>
      mockLines = [
        '<Attributes>',                    // line 0
        '  <Attribute Name="Existing"/>', // line 1 (existing content)
        '</Attributes>'                   // line 2
      ];

      const targetSection = {
        openTagLine: 0,
        closeTagLine: 2,
        lastChildLine: 1,  // Has existing content
        isSelfClosing: false
      };

      const newContent = '  <Attribute Name="New"/>';
      const result = testInjectionFormatting(targetSection, newContent);

      // Should NOT have leading newline (no extra empty line)
      assert.strictEqual(result.insertionText, '  <Attribute Name="New"/>\n');
      assert.ok(!result.insertionText.startsWith('\n'), 'Should not start with newline');
    });

    it('should add leading newline when inserting into empty element', function() {
      // Mock XML structure for empty element:
      // <Attributes>
      // </Attributes>
      mockLines = [
        '<Attributes>',     // line 0  
        '</Attributes>'     // line 1
      ];

      const targetSection = {
        openTagLine: 0,
        closeTagLine: 1,
        lastChildLine: 0,  // No existing content (lastChild same as openTag)
        isSelfClosing: false
      };

      const newContent = '  <Attribute Name="New"/>';
      const result = testInjectionFormatting(targetSection, newContent);

      // Should have leading newline for proper formatting
      assert.strictEqual(result.insertionText, '\n  <Attribute Name="New"/>\n');
      assert.ok(result.insertionText.startsWith('\n'), 'Should start with newline for empty element');
    });

    it('should handle self-closing elements correctly', function() {
      // Mock XML structure for self-closing element:
      // <Attributes/>
      mockLines = [
        '<Attributes/>'     // line 0
      ];

      const targetSection = {
        openTagLine: 0,
        closeTagLine: 0,
        lastChildLine: 0,
        isSelfClosing: true
      };

      const newContent = '  <Attribute Name="New"/>';
      const result = testInjectionFormatting(targetSection, newContent);

      // Self-closing should always add leading newline
      assert.strictEqual(result.insertionText, '\n  <Attribute Name="New"/>');
      assert.ok(result.insertionText.startsWith('\n'), 'Self-closing should start with newline');
    });

    it('should prevent empty line regression scenario', function() {
      // This tests the specific scenario reported by the user
      // Before fix: always added '\n' + content + '\n' = empty line above
      // After fix: only add '\n' when element is empty
      
      mockLines = [
        '    <Attributes>',
        '      <Attribute Name="ExistingAttr"/>',
        '    </Attributes>'
      ];

      const targetSection = {
        openTagLine: 0,
        closeTagLine: 2,
        lastChildLine: 1,  // Has existing content
        isSelfClosing: false
      };

      const newContent = '      <Attribute Name="NewAttr"/>';
      const result = testInjectionFormatting(targetSection, newContent);

      // Verify no leading newline (prevents empty line above injection)
      assert.strictEqual(result.insertionText, '      <Attribute Name="NewAttr"/>\n');
      
      // Verify it doesn't create the problematic pattern
      assert.ok(!result.insertionText.match(/^\n.*\n$/), 'Should not match old problematic pattern');
    });
  });
});