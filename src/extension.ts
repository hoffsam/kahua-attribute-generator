import * as vscode from 'vscode';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';

/**
 * Regex pattern for detecting conditional expressions in fragment keys
 * Handles nested braces like {$token} inside conditionals
 */
const FRAGMENT_CONDITIONAL_PATTERN = /\{.*\?.*:.*\}/;

/**
 * Represents a conditional expression result
 */
interface ConditionalResult {
  condition: boolean;
  hasValidTokens: boolean;
  invalidTokens: string[];
}

/**
 * Configuration for reading token values from source XML
 */
interface TokenReadPath {
  type: 'attribute' | 'text' | 'selection';
  path: string;
  attribute?: string;
  affectsInjection?: boolean;
  injectionPathTemplate?: string;
}

/**
 * Configuration interfaces for the new system
 */
interface TokenNameDefinition {
  id: string;
  name: string;
  type: 'header' | 'table';
  tokens: string;
  tokenReadPaths?: Record<string, TokenReadPath>;
}

interface FragmentDefinition {
  id: string;
  name: string;
  type?: 'grouped' | 'table'; // Default is 'grouped'
  tokenReferences: string[];
  fragments: Record<string, string | Record<string, string | Record<string, string>>>;
}

interface FragmentSet {
  header?: string;
  body?: string;
  footer?: string;
  [key: string]: string | undefined;
}

interface MenuOption {
  name: string;
  fragments: string[];
}

/**
 * Parsed token information
 */
interface ParsedToken {
  name: string;
  defaultValue: string;
}

/**
 * Output target options for generated XML
 */
type OutputTarget =
  | { type: 'currentFile'; uri: vscode.Uri }
  | { type: 'selectFile'; uri: vscode.Uri }
  | { type: 'newEditor' }
  | { type: 'clipboard' };

/**
 * Map to track which XML file a snippet/template document came from
 * Key: URI of snippet/template document
 * Value: URI of the source XML file
 */
const sourceXmlFileMap = new Map<string, vscode.Uri>();

/**
 * Represents a parsed section from generated XML output
 */
interface XmlSection {
  name: string;          // e.g., "Attributes", "Labels", "DataTags"
  content: string;       // The actual XML content
  startLine: number;     // Line number in generated output
  endLine: number;       // Line number in generated output
}

/**
 * Represents a section in the target XML file
 */
interface XmlTargetSection {
  tagName: string;              // e.g., "Attributes", "Labels"
  openTagLine: number;          // Line number of opening tag
  closeTagLine: number;         // Line number of closing tag
  indentation: string;          // Whitespace prefix for indentation
  isSelfClosing: boolean;       // True if <Tag />
  lastChildLine: number;        // Line number of last child element
  context?: string;             // Context info for disambiguation (e.g., Name="Invoice")
  injectionPath?: string;       // The injection path that found this section
}

/**
 * Insertion strategy for XML content
 */
type InsertionStrategy = 'smart' | 'cursor';

/**
 * Result of an injection operation
 */
interface InjectionResult {
  sectionName: string;
  status: 'injected' | 'skipped';
  reason?: 'not-configured' | 'not-found';
}

/* ----------------------------- config helpers ----------------------------- */

function currentResource(): vscode.Uri | undefined {
  return vscode.window.activeTextEditor?.document?.uri
      ?? vscode.workspace.workspaceFolders?.[0]?.uri;
}

function getKahuaConfig(resource?: vscode.Uri) {
  return vscode.workspace.getConfiguration('kahua', resource);
}

/**
 * Converts a token value to PascalCase by removing spaces and special characters
 * and capitalizing the first letter of each word
 */
function toPascalCase(value: string): string {
  if (!value) return value;

  // Split on word boundaries (spaces, punctuation, etc.) and filter out empty strings
  return value
    .split(/[^a-zA-Z0-9]+|(?=[A-Z][a-z])/)
    .filter(word => word.length > 0)
    .map(word => {
      // If word is already PascalCase (starts with uppercase and has mixed case), preserve it
      if (word.charAt(0) === word.charAt(0).toUpperCase() && word !== word.toUpperCase() && word !== word.toLowerCase()) {
        return word;
      }
      // Otherwise, apply standard PascalCase transformation
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join('');
}

/**
 * Converts a token value to TitleCase following standard capitalization rules
 */
function toTitleCase(value: string): string {
  if (!value) return value;

  // First, convert PascalCase and numbers to space-separated words
  // Insert space before capital letters (except the first character)
  // Insert space before and after numbers when adjacent to letters
  const spacedValue = value
    .replace(/([a-z])([A-Z])/g, '$1 $2')  // PascalCase: letter before capital
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')  // Letter before number
    .replace(/(\d)([a-zA-Z])/g, '$1 $2'); // Number before letter

  // Words that should remain lowercase (articles, short prepositions, conjunctions)
  const lowercaseWords = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'yet', 'so',
    'in', 'on', 'at', 'by', 'for', 'of', 'to', 'up', 'as'
  ]);


  // Split into words while preserving spaces
  const words = spacedValue.toLowerCase().split(/(\s+)/);

  return words.map((word, index) => {
    // Preserve whitespace as-is
    if (/^\s+$/.test(word)) {
      return word;
    }


    // Always capitalize first and last word
    const isFirstWord = index === 0 || words.slice(0, index).every(w => /^\s+$/.test(w));
    const isLastWord = index === words.length - 1 || words.slice(index + 1).every(w => /^\s+$/.test(w));


    if (isFirstWord || isLastWord || !lowercaseWords.has(word.toLowerCase())) {
      return word.charAt(0).toUpperCase() + word.slice(1);
    }


    return word;
  }).join('');
}

/**
 * Escapes XML special characters in a string
 */
function escapeXml(value: string): string {
  if (!value) return value;

  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Formats XML content with proper indentation
 * Note: This is a simple formatter designed for the extension's typical output structure
 */
function formatXml(xml: string, _indentSize: number = 2): string {
  if (xml == null) return xml as unknown as string;
  return String(xml).replace(/\r\n?/g, '\n');
}

/**
 * Formats a collection of XML fragments with section headers and proper indentation
 */
// Replaces the old, unused version
type TableFragmentsMap = {
  [fragmentName: string]: {
    [group: string]: { header?: string; body: string[]; footer?: string }
  }
};

type GroupedFragmentsMap = {
  [fragmentName: string]: {
    [fragmentKey: string]: string[]
  }
};

/**
 * Renders fragment collections (both table-style groups and grouped fragments)
 * into a single string, preserving author formatting by default.
 *
 * - Adds a leading space before comment headers ( " <!-- ... -->" )
 * - Preserves blank lines and fragment formatting; only calls formatXml if applyFormatting === true
 */
function formatFragmentCollection(
  opts: {
    table?: TableFragmentsMap,
    grouped?: GroupedFragmentsMap,
    applyFormatting?: boolean,
    indentSize?: number
  }
): string {
  const { table, grouped, applyFormatting = false, indentSize = 2 } = opts;
  const sections: string[] = [];

  // Table (header/body/footer) groups
  if (table) {
    for (const [fragmentName, groupsMap] of Object.entries(table)) {
      for (const [group, partsObj] of Object.entries(groupsMap)) {
        const parts: string[] = [];
        if (partsObj.header) parts.push(partsObj.header);
        parts.push(...partsObj.body);
        if (partsObj.footer) parts.push(partsObj.footer);

        const label = group === 'default' ? fragmentName : `${fragmentName} - ${group}`;
        let body = parts.join('\n');
        if (applyFormatting) body = formatXml(body, indentSize);

        sections.push(`\n <!-- ${label} -->\n\n${body}`);
      }
    }
  }

  // Grouped (named) fragments
  if (grouped) {
    for (const [_fragmentName, fragmentGroups] of Object.entries(grouped)) {
      for (const [fragmentKey, fragments] of Object.entries(fragmentGroups)) {
        let body = fragments.join('\n');
        if (applyFormatting) body = formatXml(body, indentSize);

        sections.push(`\n <!-- ${fragmentKey} -->\n\n${body}`);
      }
    }
  }

  return sections.join('\n');
}

/**
 * Finds all XML files in the workspace
 */
async function findXmlFilesInWorkspace(): Promise<vscode.Uri[]> {
  const files = await vscode.workspace.findFiles(
    '**/*.xml',
    '{**/node_modules/**,**/out/**,**/.vscode/**}'
  );
  return files.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
}

/**
 * Gets workspace-relative path for a URI, or full path if not in workspace
 */
function getWorkspaceRelativePath(uri: vscode.Uri): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (workspaceFolder) {
    return vscode.workspace.asRelativePath(uri, false);
  }
  return uri.fsPath;
}

/**
 * Shows a quick pick menu for selecting where to output generated XML
 */
async function showOutputTargetQuickPick(currentFileUri?: vscode.Uri): Promise<OutputTarget | undefined> {
  const items: vscode.QuickPickItem[] = [];

  // Check if current document has an associated source XML file (from snippet/template generation)
  let targetXmlFile: vscode.Uri | undefined;
  if (currentFileUri) {
    targetXmlFile = sourceXmlFileMap.get(currentFileUri.toString());
  }

  // Option 1: Associated XML file from snippet/template generation, or current file if it's XML
  if (targetXmlFile) {
    // We have a remembered XML file from snippet/template generation
    items.push({
      label: `$(file) Source XML File`,
      description: getWorkspaceRelativePath(targetXmlFile),
      detail: 'Insert into the XML file where this snippet/template was generated from',
      alwaysShow: true
    });
  } else if (currentFileUri?.fsPath.toLowerCase().endsWith('.xml')) {
    // Current file itself is an XML file
    items.push({
      label: `$(file) Current File`,
      description: getWorkspaceRelativePath(currentFileUri),
      detail: 'Insert into the current XML file at cursor position',
      alwaysShow: true
    });
  }

  // Option 2: Select XML file from workspace
  const xmlFiles = await findXmlFilesInWorkspace();
  if (xmlFiles.length > 0) {
    items.push({
      label: `$(search) Select XML File...`,
      description: `${xmlFiles.length} XML file(s) found in workspace`,
      detail: 'Choose a specific XML file to insert into',
      alwaysShow: true
    });
  }

  // Option 3: Browse for file
  items.push({
    label: `$(folder-opened) Browse for File...`,
    detail: 'Browse for any XML file on your system',
    alwaysShow: true
  });

  // Option 4: New editor tab
  items.push({
    label: `$(new-file) New Editor Tab`,
    detail: 'Open generated XML in a new editor window',
    alwaysShow: true
  });

  // Option 5: Clipboard
  items.push({
    label: `$(clippy) Clipboard`,
    detail: 'Copy generated XML to clipboard',
    alwaysShow: true
  });

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Where would you like to output the generated XML?',
    title: 'Kahua: Select Output Target'
  });

  if (!selected) {
    return undefined;
  }

  // Handle selection
  if (selected.label.includes('Source XML File') && targetXmlFile) {
    return { type: 'currentFile', uri: targetXmlFile };
  } else if (selected.label.includes('Current File') && currentFileUri) {
    return { type: 'currentFile', uri: currentFileUri };
  } else if (selected.label.includes('Select XML File')) {
    const fileItems = xmlFiles.map(uri => ({
      label: getWorkspaceRelativePath(uri),
      description: uri.fsPath,
      uri
    }));

    const selectedFile = await vscode.window.showQuickPick(fileItems, {
      placeHolder: 'Select an XML file',
      title: 'Kahua: Choose XML File'
    });

    if (!selectedFile) {
      return undefined;
    }

    return { type: 'selectFile', uri: selectedFile.uri };
  } else if (selected.label.includes('Browse for File')) {
    const browseResult = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFiles: true,
      canSelectFolders: false,
      filters: {
        'XML Files': ['xml'],
        'All Files': ['*']
      },
      title: 'Select XML File to Insert Into'
    });

    if (!browseResult || browseResult.length === 0) {
      return undefined;
    }

    return { type: 'selectFile', uri: browseResult[0] };
  } else if (selected.label.includes('New Editor Tab')) {
    return { type: 'newEditor' };
  } else {
    return { type: 'clipboard' };
  }
}

/**
 * Inserts XML content into a file with smart section-aware insertion or cursor-based insertion
 * Returns injection results for reporting
 */
async function insertXmlIntoFile(uri: vscode.Uri, content: string, strategy?: InsertionStrategy, fragmentDefinition?: any): Promise<InjectionResult[]> {
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, {
    preserveFocus: false,
    preview: false
  });

  if (!strategy || strategy === 'cursor') {
    // Simple insertion at cursor position
    const position = editor.selection.active;
    await editor.edit(editBuilder => {
      editBuilder.insert(position, '\n' + content + '\n');
    });

    const lines = content.split('\n').length;
    const newPosition = position.translate(lines + 2, 0);
    editor.selection = new vscode.Selection(newPosition, newPosition);
    return []; // No tracking for cursor mode
  }

  // Smart insertion - get injection paths from the fragment definition
  const injectionPaths: Record<string, string> = fragmentDefinition?.injectionPaths || {};
  const results: InjectionResult[] = [];

  const generatedSections = parseGeneratedXmlSections(content);
  const allTargetSections = parseTargetXmlStructure(document, injectionPaths);

  // Deduplicate target sections that point to the same line
  // (happens when multiple section names map to the same xpath)
  const seenLines = new Set<number>();
  const targetSections = allTargetSections.filter(section => {
    if (seenLines.has(section.openTagLine)) {
      console.log(`[DEBUG] Skipping duplicate target section at line ${section.openTagLine + 1}`);
      return false;
    }
    seenLines.add(section.openTagLine);
    return true;
  });

  const matches = matchSectionsToTargets(generatedSections, targetSections);

  // Prompt user for strategy
  const insertionStrategy = await showInsertionStrategyPick(
    Array.from(matches.values()).some(m => m.length > 0)
  );

  if (!insertionStrategy) {
    return []; // User cancelled
  }

  if (insertionStrategy === 'cursor') {
    // Fall back to cursor insertion
    const position = editor.selection.active;
    await editor.edit(editBuilder => {
      editBuilder.insert(position, '\n' + content + '\n');
    });
    return [];
  }

  // For sections with multiple targets, prompt user to select which to use
  const selectedTargets = new Map<string, XmlTargetSection[]>();

  for (const [sectionName, targetMatches] of matches.entries()) {
    if (targetMatches.length === 0) {
      selectedTargets.set(sectionName, []);
    } else if (targetMatches.length === 1) {
      selectedTargets.set(sectionName, targetMatches);
    } else {
      // Multiple matches - ask user to select
      const selected = await selectTargetsFromMultiple(sectionName, targetMatches);
      if (selected) {
        selectedTargets.set(sectionName, selected);
      } else {
        selectedTargets.set(sectionName, []);
      }
    }
  }

  // Perform smart insertion
  await editor.edit(editBuilder => {
    for (const [sectionName, targets] of selectedTargets.entries()) {
      const genSection = generatedSections.find(s => s.name === sectionName);
      if (!genSection) {
        continue;
      }

      if (targets.length > 0) {
        // Insert into all selected targets
        for (const targetSection of targets) {
          const insertLine = targetSection.lastChildLine;
          const insertPosition = document.lineAt(insertLine).range.end;
          const indentedContent = indentContent(
            genSection.content,
            targetSection.indentation + '  '
          );

          editBuilder.insert(
            insertPosition,
            '\n' + indentedContent
          );
        }

        // Track successful injection
        results.push({
          sectionName: `${sectionName}${targets.length > 1 ? ` (${targets.length} locations)` : ''}`,
          status: 'injected'
        });
      } else {
        // Section not matched - determine why
        const isConfigured = isSectionConfigured(sectionName, injectionPaths);

        results.push({
          sectionName: sectionName,
          status: 'skipped',
          reason: isConfigured ? 'not-found' : 'not-configured'
        });
      }
    }
  });

  return results;
}

/**
 * Parses generated XML into sections based on comment headers, excluding reporting grids
 */
function parseGeneratedXmlSections(generatedXml: string): XmlSection[] {
  const sections: XmlSection[] = [];
  const lines = generatedXml.split('\n');
  let currentSection: XmlSection | null = null;
  const sectionContent: string[] = [];
  let skipUntilNextSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Detect section headers: <!-- SectionName -->
    const headerMatch = line.match(/^<!--\s*(.+?)\s*-->$/);

    if (headerMatch) {
      const sectionName = headerMatch[1];

      // Skip sections that are reporting grids (contain "Token", "Configuration", "Values", etc.)
      if (sectionName.includes('Token') || sectionName.includes('Configuration') || sectionName.includes('Values')) {
        skipUntilNextSection = true;
        if (currentSection) {
          currentSection.content = sectionContent.join('\n').trim();
          currentSection.endLine = i - 1;
          sections.push(currentSection);
          sectionContent.length = 0;
          currentSection = null;
        }
        continue;
      }

      // Save previous section if exists
      if (currentSection) {
        currentSection.content = sectionContent.join('\n').trim();
        currentSection.endLine = i - 1;
        sections.push(currentSection);
        sectionContent.length = 0;
      }

      skipUntilNextSection = false;

      // Start new section
      currentSection = {
        name: sectionName,
        content: '',
        startLine: i + 1,
        endLine: i + 1
      };
    } else if (!skipUntilNextSection && currentSection && line && !line.startsWith('<!--')) {
      // Add non-comment, non-empty lines to current section (but not if we're in a skip section)
      sectionContent.push(lines[i]);
    }
  }

  // Save final section (only if not skipping)
  if (!skipUntilNextSection && currentSection && sectionContent.length > 0) {
    currentSection.content = sectionContent.join('\n').trim();
    currentSection.endLine = lines.length - 1;
    sections.push(currentSection);
  }

  return sections;
}

/**
 * Finds the closing tag for a given opening tag
 */
function findClosingTag(document: vscode.TextDocument, tagName: string, startLine: number): number {
  let depth = 1;
  for (let i = startLine + 1; i < document.lineCount; i++) {
    const text = document.lineAt(i).text;
    if (text.includes(`<${tagName}`)) {
      depth++;
    }
    if (text.includes(`</${tagName}>`)) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return startLine; // Fallback
}

/**
 * Finds the last child element before the closing tag
 */
function findLastChildElement(document: vscode.TextDocument, openLine: number, closeLine: number): number {
  // Find the last non-empty, non-comment line before closing tag
  for (let i = closeLine - 1; i > openLine; i--) {
    const text = document.lineAt(i).text.trim();
    if (text && !text.startsWith('<!--') && !text.startsWith('</')) {
      return i;
    }
  }
  return openLine;
}

/**
 * Parses target XML file to find section tags where content can be inserted using configured injection paths
 * Creates multiple target sections when there are multiple matches for a path
 */
function parseTargetXmlStructure(document: vscode.TextDocument, injectionPaths: Record<string, string>): XmlTargetSection[] {
  const sections: XmlTargetSection[] = [];

  for (const [sectionName, xpath] of Object.entries(injectionPaths)) {
    const allTargetLines = findAllXPathTargets(document, xpath);

    // Deduplicate line numbers
    const uniqueLines = [...new Set(allTargetLines)];
    console.log(`[DEBUG] parseTargetXmlStructure: ${sectionName} -> ${uniqueLines.length} unique lines (from ${allTargetLines.length} total)`);

    for (const targetLine of uniqueLines) {
      const line = document.lineAt(targetLine);
      const text = line.text;

      // Extract tag name from the line
      const tagMatch = text.match(/<(\w+)/);
      if (tagMatch) {
        const tagName = tagMatch[1];
        const indentation = text.match(/^(\s*)</)?.[1] || '';
        const isSelfClosing = text.includes('/>');

        if (isSelfClosing) {
          sections.push({
            tagName: sectionName,
            openTagLine: targetLine,
            closeTagLine: targetLine,
            indentation,
            isSelfClosing: true,
            lastChildLine: targetLine,
            context: `Line ${targetLine + 1}`,
            injectionPath: xpath
          });
        } else {
          const closeTagLine = findClosingTag(document, tagName, targetLine);
          const lastChildLine = findLastChildElement(document, targetLine, closeTagLine);

          sections.push({
            tagName: sectionName,
            openTagLine: targetLine,
            closeTagLine,
            indentation,
            isSelfClosing: false,
            lastChildLine,
            context: `Line ${targetLine + 1}`,
            injectionPath: xpath
          });
        }
      }
    }
  }

  return sections;
}

/**
 * Parse XML document using fast-xml-parser
 */
function parseXmlDocument(document: vscode.TextDocument): any {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    ignoreDeclaration: true,
    preserveOrder: false,
    allowBooleanAttributes: true
  });

  const xmlText = document.getText();
  return parser.parse(xmlText);
}

/**
 * Traverse parsed XML object to find elements matching XPath
 * Returns elements with their identifying attributes
 */
function findElementsByXPath(parsedXml: any, xpath: string): Array<{tagName: string, attributes: Record<string, any>}> {
  console.log(`[DEBUG] findElementsByXPath called with xpath: ${xpath}`);
  console.log(`[DEBUG] parsedXml root keys:`, Object.keys(parsedXml));

  let parts = xpath.split('/').filter(p => p);

  // Start from the actual document root (skip the wrapper object)
  // fast-xml-parser wraps everything in the root element
  let currentElements: any[] = [];

  // Find the actual root element (usually the first key in parsedXml)
  const rootKeys = Object.keys(parsedXml);
  if (rootKeys.length > 0) {
    // If the first part of xpath matches the root element, skip it
    const rootElement = parsedXml[rootKeys[0]];
    if (rootKeys[0] === parts[0]) {
      console.log(`[DEBUG] Root element ${rootKeys[0]} matches first part of xpath, starting from inside it`);
      currentElements = [rootElement];
      parts = parts.slice(1); // Remove the matched root element from parts
    } else {
      console.log(`[DEBUG] Root element is ${rootKeys[0]}, searching within it`);
      currentElements = [rootElement];
    }
  } else {
    currentElements = [parsedXml];
  }

  for (const part of parts) {
    // Parse part for tag name and optional attribute condition
    const attrMatch = part.match(/^(\w+)\[@(\w+)='([^']+)'\]$/);
    const tagName = attrMatch ? attrMatch[1] : part;
    const filterAttrName = attrMatch ? attrMatch[2] : null;
    const filterAttrValue = attrMatch ? attrMatch[3] : null;

    const nextElements: any[] = [];

    for (const element of currentElements) {
      if (typeof element === 'object' && element !== null) {
        // Check if this element has the tag we're looking for
        if (element[tagName]) {
          const candidates = Array.isArray(element[tagName]) ? element[tagName] : [element[tagName]];

          for (const candidate of candidates) {
            // Apply attribute filter if specified
            if (filterAttrName && filterAttrValue) {
              const attrKey = `@_${filterAttrName}`;
              if (candidate[attrKey] !== filterAttrValue) {
                continue;
              }
            }

            nextElements.push(candidate);
          }
        }
      }
    }

    if (nextElements.length === 0) {
      console.log(`[DEBUG] No elements found for part: ${part}`);
      return [];
    }

    currentElements = nextElements;
    console.log(`[DEBUG] Found ${currentElements.length} elements for part: ${part}`);
  }

  // Extract tag name and attributes from matched elements
  const lastPart = parts[parts.length - 1];
  const tagName = lastPart.match(/^(\w+)/)?.[1] || lastPart;

  return currentElements.map(element => {
    const attributes: Record<string, any> = {};

    // Extract all attributes (prefixed with @_)
    for (const key in element) {
      if (key.startsWith('@_')) {
        const attrName = key.substring(2);
        attributes[attrName] = element[key];
      }
    }

    return { tagName, attributes };
  });
}

/**
 * Find line numbers in document for elements with specific attributes
 */
function findLineNumbersForElements(
  document: vscode.TextDocument,
  tagName: string,
  elements: Array<{attributes: Record<string, any>}>
): number[] {
  const lineNumbers: number[] = [];

  for (const element of elements) {
    // Build a pattern to match this specific element
    // Look for opening tag with the attributes
    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i).text;

      // Check if line contains opening tag
      if (!line.includes(`<${tagName}`)) {
        continue;
      }

      // Check if all attributes match
      let allAttributesMatch = true;
      for (const [attrName, attrValue] of Object.entries(element.attributes)) {
        const attrPattern = new RegExp(`${attrName}\\s*=\\s*["']${attrValue}["']`);
        if (!attrPattern.test(line)) {
          allAttributesMatch = false;
          break;
        }
      }

      // If no attributes specified, just match the tag
      if (Object.keys(element.attributes).length === 0) {
        allAttributesMatch = true;
      }

      if (allAttributesMatch && !lineNumbers.includes(i)) {
        lineNumbers.push(i);
        break; // Found this element, move to next
      }
    }
  }

  return lineNumbers;
}

/**
 * Finds all target lines for an XPath-like expression in the XML document
 * Uses fast-xml-parser for accurate XML parsing
 * Returns array of line numbers only
 */
function findAllXPathTargets(document: vscode.TextDocument, xpath: string): number[] {
  console.log(`[DEBUG] findAllXPathTargets called with xpath: ${xpath}`);

  try {
    // Parse XML document
    const parsedXml = parseXmlDocument(document);

    // Find elements matching XPath
    const elements = findElementsByXPath(parsedXml, xpath);
    console.log(`[DEBUG] Found ${elements.length} elements via XPath`);

    if (elements.length === 0) {
      return [];
    }

    // Get the tag name from elements (it's already extracted)
    const tagName = elements[0].tagName;

    // Find line numbers for these elements
    const lineNumbers = findLineNumbersForElements(document, tagName, elements);
    console.log(`[DEBUG] Mapped to ${lineNumbers.length} line numbers`);

    return lineNumbers;
  } catch (error) {
    console.error(`[ERROR] Failed to parse XML or find elements:`, error);
    return [];
  }
}

/**
 * Finds the target line for an XPath-like expression in the XML document (first match only)
 * Supports: TagName, Parent/Child, Parent/Child[@Attr='value']
 */
function findXPathTarget(document: vscode.TextDocument, xpath: string): number {
  const matches = findAllXPathTargets(document, xpath);
  return matches.length > 0 ? matches[0] : -1;
}

/**
 * Extracts an attribute value from XML using XPath
 * Uses fast-xml-parser for accurate parsing
 * Supports paths like "App/@Name" or "EntityDefs/EntityDef/@Name"
 */
function extractAttributeValue(document: vscode.TextDocument, xpath: string): string | undefined {
  if (!xpath.includes('/@')) {
    return undefined;
  }

  const parts = xpath.split('/@');
  const elementPath = parts[0];
  const attributeName = parts[1];

  try {
    const parsedXml = parseXmlDocument(document);

    // Special case: if elementPath is the root element name, get attributes from root
    const rootKeys = Object.keys(parsedXml);
    if (rootKeys.length > 0 && rootKeys[0] === elementPath) {
      console.log(`[DEBUG] Extracting attribute from root element: ${rootKeys[0]}`);
      const rootElement = parsedXml[rootKeys[0]];
      const attrKey = `@_${attributeName}`;
      const value = rootElement[attrKey];
      console.log(`[DEBUG] Root element attribute ${attributeName} = ${value}`);
      return value;
    }

    const elements = findElementsByXPath(parsedXml, elementPath);

    if (elements.length === 0) {
      return undefined;
    }

    // Return attribute from first matching element
    return elements[0].attributes[attributeName];
  } catch (error) {
    console.error(`[ERROR] Failed to extract attribute value:`, error);
    return undefined;
  }
}

/**
 * Extracts text content from an XML element
 */
function extractTextContent(document: vscode.TextDocument, xpath: string): string | undefined {
  const targetLine = findXPathTarget(document, xpath);
  if (targetLine === -1) {
    return undefined;
  }

  const text = document.lineAt(targetLine).text.trim();
  const contentMatch = text.match(/>([^<]+)</);

  return contentMatch ? contentMatch[1] : undefined;
}

/**
 * Finds all elements matching an XPath and extracts their attribute values
 * Uses fast-xml-parser for accurate parsing
 * Returns array of {value, context} for selection UI
 * Filters out elements that don't have the required attribute
 * Uses the configured attribute name for extraction - no hardcoded attributes
 */
function extractSelectableValues(
  document: vscode.TextDocument,
  xpath: string,
  attributeName: string
): Array<{value: string, context: string}> {
  try {
    const parsedXml = parseXmlDocument(document);
    const elements = findElementsByXPath(parsedXml, xpath);

    console.log(`[DEBUG] extractSelectableValues found ${elements.length} elements`);

    return elements
      .map(element => {
        const value = element.attributes[attributeName];

        if (!value) {
          return null; // Filter out elements without the attribute
        }

        return {
          value: value,
          context: `${element.tagName}`
        };
      })
      .filter((item): item is {value: string, context: string} => item !== null);
  } catch (error) {
    console.error(`[ERROR] Failed to extract selectable values:`, error);
    return [];
  }
}

/**
 * Shows a quick pick for selecting a value from XML
 */
async function showValueSelectionPick(
  tokenName: string,
  options: Array<{value: string, context: string}>
): Promise<string | undefined> {
  if (options.length === 0) {
    return undefined;
  }

  if (options.length === 1) {
    return options[0].value;
  }

  const items = options.map(opt => ({
    label: opt.value,
    description: opt.context,
    detail: `Use "${opt.value}" as the value for ${tokenName}`,
    value: opt.value
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: `Select value for token "${tokenName}"`,
    title: `Kahua: Select ${tokenName}`,
    ignoreFocusOut: true
  });

  return selected?.value;
}

/**
 * Reads token values from source XML document based on tokenReadPaths configuration
 * Returns a map of token name to extracted value
 */
async function readTokenValuesFromXml(
  document: vscode.TextDocument,
  tokenReadPaths: Record<string, TokenReadPath>
): Promise<Map<string, string>> {
  const values = new Map<string, string>();

  for (const [tokenName, readPath] of Object.entries(tokenReadPaths)) {
    let value: string | undefined;

    switch (readPath.type) {
      case 'attribute':
        value = extractAttributeValue(document, readPath.path);
        break;

      case 'text':
        value = extractTextContent(document, readPath.path);
        break;

      case 'selection':
        if (!readPath.attribute) {
          console.log(`[DEBUG] Skipping ${tokenName}: no attribute configured`);
          continue;
        }
        console.log(`[DEBUG] Extracting values for ${tokenName} from path: ${readPath.path}, attribute: ${readPath.attribute}`);
        const options = extractSelectableValues(document, readPath.path, readPath.attribute);
        console.log(`[DEBUG] Found ${options.length} options:`, options);
        value = await showValueSelectionPick(tokenName, options);
        console.log(`[DEBUG] User selected: ${value}`);
        break;
    }

    if (value) {
      values.set(tokenName, value);
    }
  }

  return values;
}

/**
 * Generates a report text from injection results
 */
function generateInjectionReport(results: InjectionResult[], targetFileName: string): string {
  const injected = results.filter(r => r.status === 'injected');
  const skipped = results.filter(r => r.status === 'skipped');

  let report = `Kahua Attribute Generator - Injection Report\n`;
  report += `Target File: ${targetFileName}\n`;
  report += `Date: ${new Date().toLocaleString()}\n`;
  report += `${'='.repeat(70)}\n\n`;

  report += `Summary:\n`;
  report += `  Total Sections: ${results.length}\n`;
  report += `  Injected: ${injected.length}\n`;
  report += `  Skipped: ${skipped.length}\n\n`;

  if (injected.length > 0) {
    report += `Successfully Injected Sections:\n`;
    report += `${'-'.repeat(70)}\n`;
    for (const result of injected) {
      report += `  ✓ ${result.sectionName}\n`;
    }
    report += `\n`;
  }

  if (skipped.length > 0) {
    report += `Skipped Sections:\n`;
    report += `${'-'.repeat(70)}\n`;

    const notConfigured = skipped.filter(r => r.reason === 'not-configured');
    const notFound = skipped.filter(r => r.reason === 'not-found');

    if (notConfigured.length > 0) {
      report += `\n  Not Configured for Injection:\n`;
      for (const result of notConfigured) {
        report += `    ✗ ${result.sectionName}\n`;
        report += `      Reason: No injection path configured for this section\n`;
      }
    }

    if (notFound.length > 0) {
      report += `\n  Target Not Found:\n`;
      for (const result of notFound) {
        report += `    ✗ ${result.sectionName}\n`;
        report += `      Reason: Injection path configured, but target location not found in XML file\n`;
      }
    }
    report += `\n`;
  }

  report += `${'='.repeat(70)}\n`;
  report += `End of Report\n`;

  return report;
}

/**
 * Opens a new editor tab with the injection report
 */
async function openInjectionReport(results: InjectionResult[], targetFileUri: vscode.Uri): Promise<void> {
  if (results.length === 0) {
    return;
  }

  const targetFileName = getWorkspaceRelativePath(targetFileUri);
  const reportText = generateInjectionReport(results, targetFileName);

  const reportDocument = await vscode.workspace.openTextDocument({
    content: reportText,
    language: 'plaintext'
  });

  await vscode.window.showTextDocument(reportDocument, {
    viewColumn: vscode.ViewColumn.Beside,
    preview: false
  });
}

/**
 * Shows a quick pick for selecting target locations when there are multiple matches
 * Returns the selected targets, or undefined if cancelled
 */
async function selectTargetsFromMultiple(
  sectionName: string,
  targets: XmlTargetSection[]
): Promise<XmlTargetSection[] | undefined> {
  if (targets.length === 0) {
    return undefined;
  }

  if (targets.length === 1) {
    return targets;
  }

  const items = targets.map((target, index) => ({
    label: `Line ${target.openTagLine + 1}`,
    description: target.context && target.context !== `Line ${target.openTagLine + 1}` ? target.context : undefined,
    detail: target.injectionPath,
    target: target,
    picked: false
  }));

  items.push({
    label: '$(check-all) Select All',
    description: `Inject into all ${targets.length} locations`,
    detail: 'Apply to all matching targets',
    target: null as any,
    picked: false
  });

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: `Multiple targets found for "${sectionName}". Select target location(s)`,
    title: 'Kahua: Select Injection Target',
    canPickMany: true,
    ignoreFocusOut: true
  });

  if (!selected || selected.length === 0) {
    return undefined;
  }

  const selectAllChosen = selected.some(s => s.label.includes('Select All'));

  if (selectAllChosen) {
    return targets;
  }

  return selected.map(s => s.target).filter(t => t !== null);
}

/**
 * Checks if a section name is configured in the injection paths
 */
function isSectionConfigured(sectionName: string, injectionPaths: Record<string, string>): boolean {
  // Extract key words from section name
  const genWords = sectionName
    .toLowerCase()
    .replace(/extension|supplement|group \d+|default/gi, '')
    .split(/[-\s]+/)
    .filter(w => w.length > 2);

  // Check if any configured path name matches
  for (const configuredName of Object.keys(injectionPaths)) {
    const configName = configuredName.toLowerCase();

    for (const word of genWords) {
      // Direct match or plural match
      if (configName === word ||
          configName === word + 's' ||
          configName + 's' === word ||
          configName.includes(word) ||
          word.includes(configName)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Matches generated sections to target XML sections intelligently
 * Returns all matching targets for each section (may be multiple)
 */
function matchSectionsToTargets(
  generatedSections: XmlSection[],
  targetSections: XmlTargetSection[]
): Map<string, XmlTargetSection[]> {
  const matches = new Map<string, XmlTargetSection[]>();

  for (const genSection of generatedSections) {
    const allMatches: XmlTargetSection[] = [];

    // Extract key words from generated section name
    // e.g., "Extension Attributes - Attributes" -> ["Attributes"]
    const genWords = genSection.name
      .toLowerCase()
      .replace(/extension|supplement|group \d+|default/gi, '')
      .split(/[-\s]+/)
      .filter(w => w.length > 2);

    for (const targetSection of targetSections) {
      const targetName = targetSection.tagName.toLowerCase();

      // Check if any word from generated section matches target
      for (const word of genWords) {
        // Direct match or plural match
        if (targetName === word ||
            targetName === word + 's' ||
            targetName + 's' === word ||
            targetName.includes(word) ||
            word.includes(targetName)) {
          allMatches.push(targetSection);
          break;
        }
      }
    }

    matches.set(genSection.name, allMatches);
  }

  return matches;
}

/**
 * Shows a quick pick menu for selecting insertion strategy
 */
async function showInsertionStrategyPick(
  hasMatchableSections: boolean
): Promise<InsertionStrategy | undefined> {
  if (!hasMatchableSections) {
    // No smart options available, just use cursor
    return 'cursor';
  }

  const items: vscode.QuickPickItem[] = [
    {
      label: `$(symbol-method) Smart Insertion`,
      detail: 'Automatically insert fragments into matching XML sections',
      alwaysShow: true
    },
    {
      label: `$(edit) Cursor Position`,
      detail: 'Insert all content at current cursor position',
      alwaysShow: true
    }
  ];

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'How would you like to insert the XML?',
    title: 'Kahua: Choose Insertion Method'
  });

  if (!selected) {
    return undefined;
  }

  return selected.label.includes('Smart') ? 'smart' : 'cursor';
}

/**
 * Indents content lines with the specified indentation string
 */
function indentContent(content: string, indentation: string): string {
  return content
    .split('\n')
    .map(line => line.trim() ? indentation + line : line)
    .join('\n');
}

/**
 * Applies transformation to a token value based on the transformation type
 */
function applyTokenTransformation(value: string, transformation: string): string {
  if (!value) return value;

  switch (transformation.toLowerCase()) {
    case 'friendly':
    case 'title':
      return escapeXml(toTitleCase(value.trim())); // Trim, apply TitleCase and XML escape
    case 'internal':
      return toPascalCase(value.trim()); // Trim and convert to PascalCase
    case 'upper':
      return escapeXml(value.trim().toUpperCase()); // Trim, convert to uppercase and XML escape
    case 'lower':
      return escapeXml(value.trim().toLowerCase()); // Trim, convert to lowercase and XML escape
    case 'slug':
      return toPascalCase(value.trim()) + '_'; // Trim, convert to PascalCase and append underscore
    case 'raw':
      return value.trim(); // Leave exactly as user typed it (no processing, including whitespace)
    default:
      return toPascalCase(value.trim()); // Default: Trim and PascalCase
  }
}

/**
 * Evaluates a conditional expression with token values
 */
function evaluateConditional(expression: string, tokenValues: Record<string, string>): ConditionalResult {
  const invalidTokens: string[] = [];
  let hasValidTokens = true;

  // Replace tokens in the expression with their values
  let processedExpression = expression;

  // Find all token references in the expression
  const tokenPattern = /\{\$(\w+)\}/g;
  let match;
  while ((match = tokenPattern.exec(expression)) !== null) {
    const tokenName = match[1];
    const tokenValue = tokenValues[tokenName];

    if (tokenValue === undefined || tokenValue === '') {
      invalidTokens.push(tokenName);
      hasValidTokens = false;
      // Replace with empty string for evaluation
      processedExpression = processedExpression.replace(match[0], '""');
    } else {
      // Replace with quoted string value for evaluation
      processedExpression = processedExpression.replace(match[0], `"${tokenValue.replace(/"/g, '\\"')}"`);
    }
  }

  try {
    // Parse and evaluate the conditional expression
    const result = evaluateExpression(processedExpression);
    return {
      condition: result,
      hasValidTokens,
      invalidTokens
    };
  } catch (error) {
    return {
      condition: false,
      hasValidTokens: false,
      invalidTokens
    };
  }
}

/**
 * Safely evaluates a conditional expression
 * Supports: ==, !=, <=, >=, <>, in, not in, ternary operator, &&, ||, parentheses
 */
function evaluateExpression(expression: string): boolean {
  // Remove extra whitespace
  expression = expression.trim();

  // Handle ternary operator (condition ? value : fallback) - need to find the main ? and : carefully
  const ternaryResult = findTernaryOperator(expression);
  if (ternaryResult) {
    const { condition } = ternaryResult;
    const conditionResult = evaluateExpression(condition);
    return conditionResult;
  }

  // Handle logical OR (||) - lowest precedence
  const orResult = findLogicalOperator(expression, '||');
  if (orResult) {
    const { left, right } = orResult;
    return evaluateExpression(left) || evaluateExpression(right);
  }

  // Handle logical AND (&&) - higher precedence than OR
  const andResult = findLogicalOperator(expression, '&&');
  if (andResult) {
    const { left, right } = andResult;
    return evaluateExpression(left) && evaluateExpression(right);
  }

  // Handle parentheses
  if (expression.startsWith('(') && expression.endsWith(')')) {
    const inner = expression.slice(1, -1).trim();
    if (isBalancedParentheses(inner)) {
      return evaluateExpression(inner);
    }
  }

  // Handle 'not in' operator
  const notInMatch = expression.match(/^"([^"]*?)"\s+not\s+in\s+\(([^)]+)\)$/i);
  if (notInMatch) {
    const [, value, listStr] = notInMatch;
    const list = listStr.split(',').map(item => item.trim().replace(/^['"]|['"]$/g, ''));
    return !list.includes(value);
  }

  // Handle 'in' operator
  const inMatch = expression.match(/^"([^"]*?)"\s+in\s+\(([^)]+)\)$/i);
  if (inMatch) {
    const [, value, listStr] = inMatch;
    const list = listStr.split(',').map(item => item.trim().replace(/^['"]|['"]$/g, ''));
    return list.includes(value);
  }

  // Handle comparison operators (support both single and double quotes)
  const comparisonMatch = expression.match(/^(['"])([^'"]*?)\1\s*(==|!=|<=|>=|<>)\s*(['"])([^'"]*?)\4$/);
  if (comparisonMatch) {
    const [, , left, operator, , right] = comparisonMatch;

    switch (operator) {
      case '==':
        return left === right;
      case '!=':
      case '<>':
        return left !== right;
      case '<=':
        return left <= right;
      case '>=':
        return left >= right;
      default:
        return false;
    }
  }

  // Handle simple boolean expressions (just the token value)
  if (expression === '""' || expression === "''" || expression === 'false' || expression === '0') {
    return false;
  }

  return true; // Default to true for non-empty values
}

/**
 * Helper function to check if parentheses are balanced in an expression
 */
function isBalancedParentheses(expression: string): boolean {
  let count = 0;
  for (const char of expression) {
    if (char === '(') count++;
    else if (char === ')') count--;
    if (count < 0) return false;
  }
  return count === 0;
}

/**
 * Finds the main ternary operator (? :) in an expression, respecting nesting and quotes
 */
function findTernaryOperator(expression: string): { condition: string; trueValue: string; falseValue: string } | null {
  let parenCount = 0;
  let questionPos = -1;
  let colonPos = -1;
  let inQuotes = false;
  let quoteChar = '';

  // Find the main ? and : operators (not inside parentheses or quotes)
  for (let i = 0; i < expression.length; i++) {
    const char = expression[i];
    const prevChar = i > 0 ? expression[i - 1] : '';

    // Handle quoted strings
    if ((char === '"' || char === "'") && prevChar !== '\\') {
      if (!inQuotes) {
        inQuotes = true;
        quoteChar = char;
      } else if (char === quoteChar) {
        inQuotes = false;
        quoteChar = '';
      }
    }

    // Only process operators when not inside quotes
    if (!inQuotes) {
      if (char === '(') parenCount++;
      else if (char === ')') parenCount--;
      else if (char === '?' && parenCount === 0 && questionPos === -1) {
        questionPos = i;
      } else if (char === ':' && parenCount === 0 && questionPos !== -1 && colonPos === -1) {
        colonPos = i;
        break;
      }
    }
  }

  if (questionPos !== -1 && colonPos !== -1) {
    const condition = expression.substring(0, questionPos).trim();
    const trueValue = expression.substring(questionPos + 1, colonPos).trim();
    const falseValue = expression.substring(colonPos + 1).trim();
    return { condition, trueValue, falseValue };
  }

  return null;
}

/**
 * Finds logical operators (&&, ||) in an expression, respecting nesting
 */
function findLogicalOperator(expression: string, operator: '&&' | '||'): { left: string; right: string } | null {
  let parenCount = 0;
  const opLength = operator.length;

  // Find the rightmost occurrence of the operator (right-to-left for correct precedence)
  for (let i = expression.length - opLength; i >= 0; i--) {
    if (expression[i] === ')') parenCount++;
    else if (expression[i] === '(') parenCount--;
    else if (parenCount === 0 && expression.substr(i, opLength) === operator) {
      const left = expression.substring(0, i).trim();
      const right = expression.substring(i + opLength).trim();
      if (left && right) {
        return { left, right };
      }
    }
  }

  return null;
}

/**
 * Processes PowerShell-style string interpolation tokens $(token) and $(token|transformation)
 */
function processStringInterpolation(
  template: string,
  cleanTokenValues: Record<string, string>,
  rawTokenValues: Record<string, string>
): string {
  let result = template;

  // Process $(token) and $(token|transformation) patterns
  const interpolationPattern = /\$\((\w+)(?:\|([^)]+))?\)/g;
  let match;

  while ((match = interpolationPattern.exec(result)) !== null) {
    const fullMatch = match[0];
    const tokenName = match[1];
    const transformation = match[2] || 'default';

    const rawValue = rawTokenValues[tokenName] || '';
    const transformedValue = applyTokenTransformation(rawValue, transformation);

    result = result.replace(fullMatch, transformedValue);
    // Reset regex to continue searching from beginning since we modified the string
    interpolationPattern.lastIndex = 0;
  }

  return result;
}

/**
 * Processes conditional blocks in template strings with improved parsing
 */
function processConditionalTemplate(template: string, tokenValues: Record<string, string>, suppressWarnings: boolean): { result: string; warnings: string[] } {
  const warnings: string[] = [];
  let result = template;

  // Find all conditional expressions in the format {expression ? value : value}
  const conditionalPattern = /\{[^{}]*\?[^{}]*:[^{}]*\}/g;
  let match;

  while ((match = conditionalPattern.exec(result)) !== null) {
    const fullMatch = match[0];
    const expression = fullMatch.slice(1, -1); // Remove { and }

    try {
      // Parse the ternary expression
      const ternaryResult = findTernaryOperator(expression);
      if (ternaryResult) {
        // Evaluate the condition (should be simple like 'Text'=='Lookup')
        const conditionResult = evaluateExpression(ternaryResult.condition);

        // Remove quotes from true/false values if they exist
        let trueValue = ternaryResult.trueValue;
        let falseValue = ternaryResult.falseValue;

        if ((trueValue.startsWith("'") && trueValue.endsWith("'")) ||
            (trueValue.startsWith('"') && trueValue.endsWith('"'))) {
          trueValue = trueValue.slice(1, -1);
        }

        if ((falseValue.startsWith("'") && falseValue.endsWith("'")) ||
            (falseValue.startsWith('"') && falseValue.endsWith('"'))) {
          falseValue = falseValue.slice(1, -1);
        }

        const replacementValue = conditionResult ? trueValue : falseValue;
        result = result.replace(fullMatch, replacementValue);

        // Reset the regex since we modified the string
        conditionalPattern.lastIndex = 0;
      } else {
        // Malformed conditional - remove it
        result = result.replace(fullMatch, '');
        conditionalPattern.lastIndex = 0;
      }
    } catch (error) {
      if (!suppressWarnings) {
        warnings.push(`Error evaluating conditional "${expression}": ${error}`);
      }
      // Remove malformed conditional
      result = result.replace(fullMatch, '');
      conditionalPattern.lastIndex = 0;
    }
  }

  return { result, warnings };
}

/**
 * Checks if a template structure represents a fragment set (has header/body/footer structure)
 */
function isFragmentSet(template: any): template is FragmentSet {
  return typeof template === 'object' &&
         template !== null &&
         (template.hasOwnProperty('header') || template.hasOwnProperty('body') || template.hasOwnProperty('footer'));
}

/**
 * Processes template fragments to handle conditional keys, nested structures, and fragment sets
 */
function processFragmentTemplates(
  fragmentTemplates: Record<string, string | Record<string, string | Record<string, string>>>,
  cleanTokenValues: Record<string, string>,
  rawTokenValues: Record<string, string>,
  suppressWarnings: boolean
): {
  processedFragmentSets: Record<string, Record<string, string>>; // setName -> { fragmentKey -> template }
  conditionalFragmentSets: Record<string, Record<string, string>>; // setName -> { conditionalKey -> template }
  warnings: string[]
} {
  console.log('[KAHUA] processFragmentTemplates called with keys:', Object.keys(fragmentTemplates));
  const processedFragmentSets: Record<string, Record<string, string>> = {};
  const conditionalFragmentSets: Record<string, Record<string, string>> = {};
  const allWarnings: string[] = [];

  // Check if this is the new nested structure (fragment sets) or legacy flat/single-level nested structure
  const hasFragmentSets = Object.values(fragmentTemplates).some(template => isFragmentSet(template));

  if (hasFragmentSets) {
    // New structure: fragments contain sets like { setA: { header: "...", body: "..." }, setB: { ... } }
    for (const [setName, setTemplate] of Object.entries(fragmentTemplates)) {
      if (isFragmentSet(setTemplate)) {
        console.log('[KAHUA] Processing fragment set:', setName);
        processedFragmentSets[setName] = {};
        conditionalFragmentSets[setName] = {};

        for (const [fragmentKey, template] of Object.entries(setTemplate)) {
          if (typeof template === 'string') {
            const strippedKey = fragmentKey.replace(/^"(.*)"$/, '$1');
            const isConditional = strippedKey.match(FRAGMENT_CONDITIONAL_PATTERN);

            if (isConditional) {
              console.log('[KAHUA] Found conditional in fragment set:', setName, fragmentKey);
              conditionalFragmentSets[setName][fragmentKey] = template;
            } else {
              processedFragmentSets[setName][fragmentKey] = template;
            }
          }
        }
      } else {
        // Mixed structure - treat non-fragment-set entries as legacy single set
        console.log('[KAHUA] Mixed structure detected, processing legacy entry:', setName);
        if (!processedFragmentSets['default']) {
          processedFragmentSets['default'] = {};
          conditionalFragmentSets['default'] = {};
        }

        if (typeof setTemplate === 'object') {
          for (const [subKey, subTemplate] of Object.entries(setTemplate)) {
            const strippedSubKey = subKey.replace(/^"(.*)"$/, '$1');
            const isConditional = strippedSubKey.match(FRAGMENT_CONDITIONAL_PATTERN);

            if (isConditional) {
              conditionalFragmentSets['default'][subKey] = subTemplate as string;
            } else {
              processedFragmentSets['default'][subKey] = subTemplate as string;
            }
          }
        } else {
          const strippedKey = setName.replace(/^"(.*)"$/, '$1');
          const isConditional = strippedKey.match(FRAGMENT_CONDITIONAL_PATTERN);

          if (isConditional) {
            conditionalFragmentSets['default'][setName] = setTemplate;
          } else {
            processedFragmentSets['default'][setName] = setTemplate;
          }
        }
      }
    }
  } else {
    // Legacy structure: treat as single default set
    console.log('[KAHUA] Legacy structure detected, processing as default set');
    processedFragmentSets['default'] = {};
    conditionalFragmentSets['default'] = {};

    for (const [key, template] of Object.entries(fragmentTemplates)) {
      if (typeof template === 'object') {
        // Handle nested structure (like body: { Attributes: "...", Labels: "..." })
        for (const [subKey, subTemplate] of Object.entries(template)) {
          const strippedSubKey = subKey.replace(/^"(.*)"$/, '$1');
          const isConditional = strippedSubKey.match(FRAGMENT_CONDITIONAL_PATTERN);

          if (isConditional) {
            console.log('[KAHUA] Found conditional in nested structure:', subKey);
            conditionalFragmentSets['default'][subKey] = subTemplate as string;
          } else {
            processedFragmentSets['default'][subKey] = subTemplate as string;
          }
        }
      } else {
        // Handle flat structure
        const strippedKey = key.replace(/^"(.*)"$/, '$1');
        const isConditional = strippedKey.match(FRAGMENT_CONDITIONAL_PATTERN);

        if (isConditional) {
          console.log('[KAHUA] Found conditional in flat structure:', key);
          conditionalFragmentSets['default'][key] = template;
        } else {
          processedFragmentSets['default'][key] = template;
        }
      }
    }
  }

  return { processedFragmentSets, conditionalFragmentSets, warnings: allWarnings };
}

/**
 * This function is called when your extension is activated.
 */
export function activate(context: vscode.ExtensionContext) {
  // Set up context menu visibility
  vscode.commands.executeCommand('setContext', 'kahua.showInContextMenu', true);

  // Clean up source XML file map when documents are closed
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument(document => {
      sourceXmlFileMap.delete(document.uri.toString());
    })
  );

  // Register attribute generation commands
  context.subscriptions.push(
    vscode.commands.registerCommand('kahua.generateAttributesExtension', () => handleSelection(['attributes'])),
    vscode.commands.registerCommand('kahua.generateAttributesSupplement', () => handleSelection(['supplements'])),
    vscode.commands.registerCommand('kahua.generateSnippetAttributes', () => generateSnippetForFragments(['attributes'])),
    vscode.commands.registerCommand('kahua.generateTemplateAttributes', () => generateTemplateForFragments(['attributes']))
  );

  // Register lookup generation commands
  context.subscriptions.push(
    vscode.commands.registerCommand('kahua.generateLookups', () => handleSelection(['lookups'])),
    vscode.commands.registerCommand('kahua.generateSnippetLookups', () => generateSnippetForFragments(['lookups'])),
    vscode.commands.registerCommand('kahua.generateTemplateLookups', () => generateTemplateForFragments(['lookups']))
  );

  // Register custom generation commands (read kahua-scoped config with resource)
  context.subscriptions.push(
    vscode.commands.registerCommand('kahua.generateCustom', async () => {
      const config = vscode.workspace.getConfiguration();
      const fragmentDefinitions = config.get<FragmentDefinition[]>('kahua.fragmentDefinitions') || [];

      if (fragmentDefinitions.length === 0) {
        vscode.window.showErrorMessage('No fragment definitions configured. Please configure kahua.fragmentDefinitions in your settings.');
        return;
      }


      const pick = await vscode.window.showQuickPick(
        fragmentDefinitions.map(def => ({
          label: def.name,
          fragments: [def.id]
        })),
        {
          placeHolder: 'Select fragment type to generate',
          title: 'Kahua Custom Fragment Generator'
        }
      );


      if (pick) {
        await handleSelection(pick.fragments);
      }
    }),
    vscode.commands.registerCommand('kahua.generateSnippetCustom', async () => {
      const pick = await selectCustomFragments('Select fragments for snippet generation');
      if (pick) {
        await generateSnippetForFragments(pick.fragments);
      }
    }),
    vscode.commands.registerCommand('kahua.generateTemplateCustom', async () => {
      const pick = await selectCustomFragments('Select fragments for template generation');
      if (pick) {
        await generateTemplateForFragments(pick.fragments);
      }
    })
  );
}

/**
 * Parses token definitions from configuration string
 */
function parseTokenDefinition(tokens: string): ParsedToken[] {
  return tokens.split(',')
    .map(t => t.trim())
    .filter(Boolean)
    .map(tokenConfig => {
      const [tokenName, defaultValue] = tokenConfig.split(':', 2);
      return {
        name: tokenName.trim(),
        defaultValue: defaultValue?.trim() || ''
      };
    });
}

/**
 * Merges token definitions with priority handling
 */
function mergeTokenDefinitions(
  tokenDefs: TokenNameDefinition[],
  referencedIds: string[]
): { headerTokens: ParsedToken[]; tableTokens: ParsedToken[]; tokenDefaults: Record<string, string> } {
  const headerTokens: ParsedToken[] = [];
  const tableTokens: ParsedToken[] = [];
  const tokenDefaults: Record<string, string> = {};
  const seenTokens = new Set<string>();

  // Process token definitions in priority order (first referenced has priority)
  for (const refId of referencedIds) {
    const tokenDef = tokenDefs.find(def => def.id === refId);
    if (!tokenDef) continue;

    const parsedTokens = parseTokenDefinition(tokenDef.tokens);

    for (const token of parsedTokens) {
      if (!seenTokens.has(token.name)) {
        seenTokens.add(token.name);
        tokenDefaults[token.name] = token.defaultValue;

        if (tokenDef.type === 'header') {
          headerTokens.push(token);
        } else {
          tableTokens.push(token);
        }
      }
    }
  }

  return { headerTokens, tableTokens, tokenDefaults };
}

/**
 * Splits input text into groups separated by empty lines
 */
function splitIntoGroups(text: string): string[][] {
  const allLines = text.split(/\r?\n/);
  const groups: string[][] = [];
  let currentGroup: string[] = [];

  for (const line of allLines) {
    if (line.trim() === '') {
      // Empty line - end current group if it has content
      if (currentGroup.length > 0) {
        groups.push(currentGroup);
        currentGroup = [];
      }
    } else {
      // Non-empty line - add to current group
      currentGroup.push(line.trim());
    }
  }

  // Add final group if it has content
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  return groups;
}

/**
 * Creates a properly formatted table with aligned columns
 */
function createFormattedTokenTable(
  tokenNames: string[],
  tokenData: Array<Record<string, string>>,
  tokenDefaults: Record<string, string>,
  groupNumber: number
): string {
  if (tokenData.length === 0) {
    return `<!-- Group ${groupNumber} - No token data -->`;
  }

  // Calculate column widths
  const columns = ['Token', 'Default', ...tokenData.map((_, i) => `Line ${i + 1}`)];
  const columnWidths = columns.map(col => col.length);

  // Update widths based on token names
  tokenNames.forEach((tokenName, tokenIndex) => {
    columnWidths[0] = Math.max(columnWidths[0], tokenName.length);

    const defaultValue = tokenDefaults[tokenName] || '';
    columnWidths[1] = Math.max(columnWidths[1], defaultValue.length);

    tokenData.forEach((data, dataIndex) => {
      const value = data[tokenName] || '';
      columnWidths[dataIndex + 2] = Math.max(columnWidths[dataIndex + 2], value.length);
    });
  });

  // Create header
  const header = '| ' + columns.map((col, i) => col.padEnd(columnWidths[i])).join(' | ') + ' |';
  const separator = '|' + columnWidths.map(width => '-'.repeat(width + 2)).join('|') + '|';

  // Create data rows
  const rows = tokenNames.map(tokenName => {
    const defaultValue = (tokenDefaults[tokenName] || '').padEnd(columnWidths[1]);
    const values = tokenData.map((data, i) => (data[tokenName] || '').padEnd(columnWidths[i + 2]));
    return '| ' + tokenName.padEnd(columnWidths[0]) + ' | ' + defaultValue + ' | ' + values.join(' | ') + ' |';
  });

  return `<!-- Group ${groupNumber} Token Configuration and Values Table -->\n${header}\n${separator}\n${rows.join('\n')}`;
}

/**
 * Renders a template with token replacement and conditional processing
 */
function renderTemplate(
  template: string,
  cleanTokenValues: Record<string, string>,
  rawTokenValues: Record<string, string>,
  suppressWarnings: boolean
): { result: string; warnings: string[] } {
  const warnings: string[] = [];

  // Phase 1: Handle {$token} transformation-controlled token replacement FIRST
  let rendered = template;
  for (const [tokenName, _cleanValue] of Object.entries(cleanTokenValues)) {
    const rawValue = rawTokenValues[tokenName] || '';

    // Find all token references with transformations in the rendered template
    const tokenPattern = new RegExp(`\\{\\$${tokenName}(?:\\|([^}]+))?\\}`, 'g');
    let match;

    while ((match = tokenPattern.exec(rendered)) !== null) {
      const fullMatch = match[0];
      const transformation = match[1] || 'default'; // Use 'default' if no transformation specified
      const transformedValue = applyTokenTransformation(rawValue, transformation);

      rendered = rendered.replace(fullMatch, transformedValue);
      // Reset the regex to continue searching from the beginning since we modified the string
      tokenPattern.lastIndex = 0;
    }
  }

  // Phase 2: Process conditional expressions (AFTER token replacement)
  const { result: conditionalProcessed, warnings: conditionalWarnings } = processConditionalTemplate(
    rendered,
    cleanTokenValues,
    suppressWarnings
  );
  warnings.push(...conditionalWarnings);

  // Phase 3: Process PowerShell-style string interpolations $(token)
  rendered = processStringInterpolation(conditionalProcessed, cleanTokenValues, rawTokenValues);

  return { result: rendered, warnings };
}

/**
 * Shows quickpick for selecting custom fragments
 */
async function selectCustomFragments(placeholder: string): Promise<{ label: string; fragments: string[] } | undefined> {
  const config = vscode.workspace.getConfiguration();
  const fragmentDefinitions = config.get<FragmentDefinition[]>('kahua.fragmentDefinitions') || [];

  if (fragmentDefinitions.length === 0) {
    vscode.window.showErrorMessage('No fragment definitions configured. Please configure kahua.fragmentDefinitions in your settings.');
    return undefined;
  }


  return await vscode.window.showQuickPick(
    fragmentDefinitions.map(def => ({
      label: def.name,
      fragments: [def.id]
    })),
    {
      placeHolder: placeholder,
      title: 'Kahua Custom Fragment Selector'
    }
  );
}

/**
 * Generates and inserts a snippet for the specified fragment types with tab-stop functionality
 */
async function generateSnippetForFragments(fragmentIds: string[]): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('No active editor found. Please open a file to insert the snippet.');
    return;
  }

  try {
    const config = getKahuaConfig(currentResource());
    const tokenDefinitions = config.get<TokenNameDefinition[]>('tokenNameDefinitions') || [];
    const fragmentDefinitions = config.get<FragmentDefinition[]>('fragmentDefinitions') || [];

    if (tokenDefinitions.length === 0) {
      throw new Error('No token name definitions found. Please configure kahua.tokenNameDefinitions in your settings.');
    }

    if (fragmentDefinitions.length === 0) {
      throw new Error('No fragment definitions found. Please configure kahua.fragmentDefinitions in your settings.');
    }

    // Validate fragment ids are known
    const unknown = fragmentIds.filter(id => !fragmentDefinitions.some(d => d.id === id));
    if (unknown.length) {
      throw new Error(`Menu references unknown fragment id(s): ${unknown.join(', ')}. Use FragmentDefinition.id (not 'name').`);
    }

    // Find the fragment definitions we need
    const selectedFragmentDefs = fragmentDefinitions.filter(def => fragmentIds.includes(def.id));
    if (selectedFragmentDefs.length === 0) {
      throw new Error(`No matching fragment definitions found for: ${fragmentIds.join(', ')}`);
    }

    // Collect all unique token references from selected fragments
    const allTokenReferences = new Set<string>();
    selectedFragmentDefs.forEach(def => {
      def.tokenReferences.forEach(ref => allTokenReferences.add(ref));
    });

    // Merge token definitions based on references
    const { headerTokens, tableTokens } = mergeTokenDefinitions(
      tokenDefinitions,
      Array.from(allTokenReferences)
    );

    // Extract values from source XML if current file is XML
    const extractedValues = new Map<string, string>();
    const sourceFileUri = editor.document.uri;
    const isSourceXmlFile = sourceFileUri.fsPath.toLowerCase().endsWith('.xml');

    console.log(`[DEBUG] generateSnippetForFragments: isSourceXmlFile=${isSourceXmlFile}, file=${sourceFileUri.fsPath}`);

    if (isSourceXmlFile) {
      // Collect all tokenReadPaths from referenced token definitions
      const referencedTokenDefs = tokenDefinitions.filter(def =>
        allTokenReferences.has(def.id)
      );

      console.log(`[DEBUG] Found ${referencedTokenDefs.length} referenced token definitions`);

      for (const tokenDef of referencedTokenDefs) {
        console.log(`[DEBUG] Checking tokenDef: ${tokenDef.id}, hasReadPaths=${!!tokenDef.tokenReadPaths}`);
        if (tokenDef.tokenReadPaths) {
          console.log(`[DEBUG] Calling readTokenValuesFromXml for ${tokenDef.id}`);
          const values = await readTokenValuesFromXml(editor.document, tokenDef.tokenReadPaths);
          console.log(`[DEBUG] Got ${values.size} values from readTokenValuesFromXml`);
          values.forEach((value, key) => extractedValues.set(key, value));
        }
      }
    }

    console.log(`[DEBUG] Total extracted values: ${extractedValues.size}`);

    // Separate header and table token definitions
    const snippetLines: string[] = [];
    let tabStopIndex = 1;
    let numberOfRows = 0; // Track total rows for message

    // Create header line if there are header tokens
    if (headerTokens.length > 0) {
      const headerParts: string[] = [];

      for (let i = 0; i < headerTokens.length; i++) {
        const token = headerTokens[i];
        // Use extracted value if available, otherwise fall back to default
        const extractedValue = extractedValues.get(token.name);
        const placeholder = extractedValue || token.defaultValue || token.name;

        // Include comma in the tabstop for proper step-over behavior
        if (i < headerTokens.length - 1) {
          headerParts.push(`\${${tabStopIndex}:${placeholder}}, `);
        } else {
          // Last token doesn't need a comma
          headerParts.push(`\${${tabStopIndex}:${placeholder}}`);
        }
        tabStopIndex++;
      }

      snippetLines.push(headerParts.join(''));
    }

    // Create table data lines if there are table tokens
    if (tableTokens.length > 0) {
      const defaultTableRows = config.get<number>('defaultSnippetTableRows') || 0;

      numberOfRows = defaultTableRows;

      // If default is 0, use current behavior (single row)
      // If default > 0, prompt user for row count with default value
      if (defaultTableRows > 0) {
        // Get the maximum value (fallback to 100 if not found)
        const maxRows = 100;

        const userInput = await vscode.window.showInputBox({
          prompt: `How many table data rows to generate? (1-${maxRows})`,
          value: defaultTableRows.toString(),
          validateInput: (value: string) => {
            const num = parseInt(value);
            if (isNaN(num) || num < 1 || num > maxRows) {
              return `Please enter a number between 1 and ${maxRows}`;
            }
            return undefined;
          }
        });

        if (userInput === undefined) {
          // User cancelled the prompt
          vscode.window.showInformationMessage('Snippet generation cancelled');
          return;
        }

        numberOfRows = parseInt(userInput);
      } else {
        // Default behavior: single row
        numberOfRows = 1;
      }

      // Generate the specified number of table rows
      for (let rowIndex = 0; rowIndex < numberOfRows; rowIndex++) {
        const tableParts: string[] = [];

        for (let i = 0; i < tableTokens.length; i++) {
          const token = tableTokens[i];
          // Use extracted value if available, otherwise fall back to default
          const extractedValue = extractedValues.get(token.name);
          const placeholder = extractedValue || token.defaultValue || token.name;

          // Include comma in the tabstop for proper step-over behavior
          if (i < tableTokens.length - 1) {
            tableParts.push(`\${${tabStopIndex}:${placeholder}}, `);
          } else {
            // Last token doesn't need a comma
            tableParts.push(`\${${tabStopIndex}:${placeholder}}`);
          }
          tabStopIndex++;
        }

        snippetLines.push(tableParts.join(''));
      }
    }

    // If no lines were created, show an error
    if (snippetLines.length === 0) {
      throw new Error('No header or table token definitions found.');
    }

    const snippetText = snippetLines.join('\n');

    // Remember the current XML file if we're in one
    const currentFileUri = editor.document.uri;
    const isCurrentFileXml = currentFileUri.fsPath.toLowerCase().endsWith('.xml');

    // Open empty document in new tab
    const newDocument = await vscode.workspace.openTextDocument({
      content: '',
      language: 'plaintext'
    });

    const snippetEditor = await vscode.window.showTextDocument(newDocument, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: false
    });

    // Insert as actual snippet with tab stops
    const snippet = new vscode.SnippetString(snippetText);
    await snippetEditor.insertSnippet(snippet);

    // If we came from an XML file, remember it for later
    if (isCurrentFileXml) {
      sourceXmlFileMap.set(newDocument.uri.toString(), currentFileUri);
    }

    const rowText = numberOfRows === 0
      ? 'header only'
      : numberOfRows === 1
        ? '1 table row'
        : `${numberOfRows} table rows`;
    vscode.window.showInformationMessage(`Kahua: Token snippet opened in new tab for ${fragmentIds.join(', ')} with ${rowText}`);

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    vscode.window.showErrorMessage(`Kahua Token Snippet: ${message}`);
  }
}

/**
 * Generates and opens a template for the specified fragment types in a new editor
 */
async function generateTemplateForFragments(fragmentIds: string[]): Promise<void> {
  const currentEditor = vscode.window.activeTextEditor;

  try {
    const config = getKahuaConfig(currentResource());
    const tokenDefinitions = config.get<TokenNameDefinition[]>('tokenNameDefinitions') || [];
    const fragmentDefinitions = config.get<FragmentDefinition[]>('fragmentDefinitions') || [];

    if (tokenDefinitions.length === 0) {
      throw new Error('No token name definitions found. Please configure kahua.tokenNameDefinitions in your settings.');
    }

    if (fragmentDefinitions.length === 0) {
      throw new Error('No fragment definitions found. Please configure kahua.fragmentDefinitions in your settings.');
    }

    // Validate fragment ids are known
    const unknown = fragmentIds.filter(id => !fragmentDefinitions.some(d => d.id === id));
    if (unknown.length) {
      throw new Error(`Menu references unknown fragment id(s): ${unknown.join(', ')}. Use FragmentDefinition.id (not 'name').`);
    }

    // Find the fragment definitions we need
    const selectedFragmentDefs = fragmentDefinitions.filter(def => fragmentIds.includes(def.id));
    if (selectedFragmentDefs.length === 0) {
      throw new Error(`No matching fragment definitions found for: ${fragmentIds.join(', ')}`);
    }

    // Collect all unique token references from selected fragments
    const allTokenReferences = new Set<string>();
    selectedFragmentDefs.forEach(def => {
      def.tokenReferences.forEach(ref => allTokenReferences.add(ref));
    });

    // Merge token definitions based on references
    const { headerTokens, tableTokens } = mergeTokenDefinitions(
      tokenDefinitions,
      Array.from(allTokenReferences)
    );

    // Extract values from source XML if current file is XML
    const extractedValues = new Map<string, string>();
    const sourceDocUri = currentEditor?.document.uri;
    const isSourceDocXml = sourceDocUri && sourceDocUri.fsPath.toLowerCase().endsWith('.xml');

    console.log(`[DEBUG] generateTemplateForFragments: isSourceDocXml=${isSourceDocXml}, file=${sourceDocUri?.fsPath}`);

    if (isSourceDocXml && currentEditor) {
      // Collect all tokenReadPaths from referenced token definitions
      const referencedTokenDefs = tokenDefinitions.filter(def =>
        allTokenReferences.has(def.id)
      );

      console.log(`[DEBUG] Found ${referencedTokenDefs.length} referenced token definitions`);

      for (const tokenDef of referencedTokenDefs) {
        console.log(`[DEBUG] Checking tokenDef: ${tokenDef.id}, hasReadPaths=${!!tokenDef.tokenReadPaths}`);
        if (tokenDef.tokenReadPaths) {
          console.log(`[DEBUG] Calling readTokenValuesFromXml for ${tokenDef.id}`);
          const values = await readTokenValuesFromXml(currentEditor.document, tokenDef.tokenReadPaths);
          console.log(`[DEBUG] Got ${values.size} values from readTokenValuesFromXml`);
          values.forEach((value, key) => extractedValues.set(key, value));
        }
      }
    }

    console.log(`[DEBUG] Total extracted values: ${extractedValues.size}`);

    // Build template text showing all token definitions
    const templateLines: string[] = [];
    templateLines.push(`// Token Template for ${fragmentIds.join(', ')}:`);

    if (headerTokens.length > 0) {
      const headerTokenDisplays = headerTokens.map(token => {
        const extractedValue = extractedValues.get(token.name);
        const displayValue = extractedValue || token.defaultValue;
        return displayValue ? `${token.name}:${displayValue}` : token.name;
      });
      templateLines.push(`// Header tokens: ${headerTokenDisplays.join(', ')}`);
    }

    if (tableTokens.length > 0) {
      const tableTokenDisplays = tableTokens.map(token => {
        const extractedValue = extractedValues.get(token.name);
        const displayValue = extractedValue || token.defaultValue;
        return displayValue ? `${token.name}:${displayValue}` : token.name;
      });
      templateLines.push(`// Table tokens: ${tableTokenDisplays.join(', ')}`);
    }

    templateLines.push('//');
    templateLines.push('// Usage: First line contains header tokens, subsequent lines contain table tokens');
    templateLines.push('');

    // Add pre-filled data line for header tokens if any were extracted
    if (headerTokens.length > 0) {
      const hasExtractedHeaderValues = headerTokens.some(token => extractedValues.has(token.name));
      if (hasExtractedHeaderValues) {
        const headerValues = headerTokens.map(token => {
          const extractedValue = extractedValues.get(token.name);
          return extractedValue || token.defaultValue || '';
        });
        templateLines.push(headerValues.join(','));
      }
    }

    // Add pre-filled data line for table tokens if any were extracted
    if (tableTokens.length > 0) {
      const hasExtractedTableValues = tableTokens.some(token => extractedValues.has(token.name));
      if (hasExtractedTableValues) {
        const tableValues = tableTokens.map(token => {
          const extractedValue = extractedValues.get(token.name);
          return extractedValue || token.defaultValue || '';
        });
        templateLines.push(tableValues.join(','));
      }
    }

    const templateText = templateLines.join('\n');

    // Remember the current XML file if we're in one
    const currentFileUri = currentEditor?.document.uri;
    const isCurrentFileXml = currentFileUri?.fsPath.toLowerCase().endsWith('.xml');

    // Open template in a new editor window
    const newDocument = await vscode.workspace.openTextDocument({
      content: templateText,
      language: 'plaintext'
    });

    await vscode.window.showTextDocument(newDocument, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: false
    });

    // If we came from an XML file, remember it for later
    if (isCurrentFileXml && currentFileUri) {
      sourceXmlFileMap.set(newDocument.uri.toString(), currentFileUri);
    }

    vscode.window.showInformationMessage(`Kahua: Token template opened in new editor for ${fragmentIds.join(', ')}`);

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    vscode.window.showErrorMessage(`Kahua Token Template: ${message}`);
  }
}

/**
 * This function is called when your extension is deactivated.
 */
export function deactivate() {
  // Extension cleanup handled by VS Code context subscriptions
}

/**
 * Handles the logic of reading the current selection and generating XML snippets
 * based on the provided fragment IDs. Validates configuration and selection, then generates
 * XML using configurable tokens and fragments.
 *
 * @param fragmentIds Array of fragment definition IDs to process
 */
async function handleSelection(fragmentIds: string[]): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor) {
    vscode.window.showErrorMessage('No active editor found');
    return;
  }

  try {
    const config = getKahuaConfig(currentResource());
    const xmlIndentSize = config.get<number>('xmlIndentSize') || 2;
    const applyFormatting = config.get<boolean>('formatXmlOutput') === true;
    const suppressWarnings = config.get<boolean>('suppressInvalidConditionWarnings') || false;

    // Get configuration arrays
    const tokenDefinitions = config.get<TokenNameDefinition[]>('tokenNameDefinitions') || [];
    const fragmentDefinitions = config.get<FragmentDefinition[]>('fragmentDefinitions') || [];

    if (tokenDefinitions.length === 0) {
      throw new Error('No token name definitions found. Please configure kahua.tokenNameDefinitions in your settings.');
    }

    if (fragmentDefinitions.length === 0) {
      throw new Error('No fragment definitions found. Please configure kahua.fragmentDefinitions in your settings.');
    }

    // Validate fragment ids are known
    const unknown = fragmentIds.filter(id => !fragmentDefinitions.some(d => d.id === id));
    if (unknown.length) {
      throw new Error(`Menu references unknown fragment id(s): ${unknown.join(', ')}. Use FragmentDefinition.id (not 'name').`);
    }

    // Find the fragment definitions we need to process
    const selectedFragmentDefs = fragmentDefinitions.filter(def => fragmentIds.includes(def.id));
    if (selectedFragmentDefs.length === 0) {
      throw new Error(`No matching fragment definitions found for: ${fragmentIds.join(', ')}`);
    }

    // Collect all unique token references from selected fragments
    const allTokenReferences = new Set<string>();
    selectedFragmentDefs.forEach(def => {
      def.tokenReferences.forEach(ref => allTokenReferences.add(ref));
    });

    // Merge token definitions based on references
    const { headerTokens, tableTokens, tokenDefaults } = mergeTokenDefinitions(
      tokenDefinitions,
      Array.from(allTokenReferences)
    );

    // Validate selection
    const selection = editor.document.getText(editor.selection);
    if (!selection || selection.trim() === '') {
      throw new Error('No text selected. Please select one or more lines of text to generate attributes.');
    }

    // Split into groups by empty lines
    const groups = splitIntoGroups(selection);
    if (groups.length === 0) {
      throw new Error('Selected text contains no valid groups. Please select text with content.');
    }

    // Process each group
    const allWarnings: string[] = [];
    const outputSections: string[] = [];

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const group = groups[groupIndex];

      // Process header tokens (first line if any header tokens exist)
      const headerTokenValues: Record<string, string> = {};
      const headerRawValues: Record<string, string> = {};
      let dataLines = group;

      if (headerTokens.length > 0 && group.length > 0) {
        const headerLine = group[0];
        const headerParts = headerLine.split(',');

        for (let i = 0; i < headerTokens.length; i++) {
          const token = headerTokens[i];
          const rawPart = headerParts[i] || '';
          const trimmedPart = rawPart.trim();

          headerRawValues[token.name] = rawPart || token.defaultValue;
          headerTokenValues[token.name] = toPascalCase(trimmedPart || token.defaultValue);
        }

        // Skip the header line for table processing
        dataLines = group.slice(1);
      }

      // Process table data for this group
      const groupTokenData: Array<Record<string, string>> = [];
      const structuredFragments: {
        [fragmentName: string]: {
          [group: string]: { header?: string; body: string[]; footer?: string }
        }
      } = {};

      const groupedFragments: { [fragmentName: string]: { [fragmentKey: string]: string[] } } = {};
      
      // Collect conditional fragments across all rows before processing
      const conditionalFragmentsByRow: Array<{
        tokenValues: { clean: Record<string, string>; raw: Record<string, string> };
        fragmentsByDef: Map<string, {
          processedFragmentSets: Record<string, Record<string, string>>;
          conditionalFragmentSets: Record<string, Record<string, string>>;
          warnings: string[]
        }>;
      }> = [];
      
      // If we have no data lines but have table tokens, that's an error
      if (tableTokens.length > 0 && dataLines.length === 0) {
        throw new Error(`Group ${groupIndex + 1}: No data lines found. Header tokens were processed but no table data rows remain.`);
      }

      for (const line of dataLines) {
        const rawParts = line.split(',');

        // Build token values for this line (combine header and table tokens)
        const rawTokenValues: Record<string, string> = { ...headerRawValues };
        const cleanTokenValues: Record<string, string> = { ...headerTokenValues };

        // Add table tokens
        for (let i = 0; i < tableTokens.length; i++) {
          const token = tableTokens[i];
          const rawPart = rawParts[i] || '';
          const trimmedPart = rawPart.trim();

          rawTokenValues[token.name] = rawPart || token.defaultValue;
          cleanTokenValues[token.name] = toPascalCase(trimmedPart || token.defaultValue);
        }

        // Store token data for the table
        groupTokenData.push({ ...cleanTokenValues });

        // Process fragment definitions for this row and store results
        const fragmentsByDef = new Map<string, {
          processedFragmentSets: Record<string, Record<string, string>>;
          conditionalFragmentSets: Record<string, Record<string, string>>;
          warnings: string[]
        }>();

        for (const fragmentDef of selectedFragmentDefs) {
          const { processedFragmentSets, conditionalFragmentSets, warnings: fragmentWarnings } = processFragmentTemplates(
            fragmentDef.fragments,
            cleanTokenValues,
            rawTokenValues,
            suppressWarnings
          );

          console.log(`[KAHUA] Fragment processing result - processedFragmentSets:`, Object.keys(processedFragmentSets));
          console.log(`[KAHUA] Fragment processing result - conditionalFragmentSets:`, Object.keys(conditionalFragmentSets));

          fragmentsByDef.set(fragmentDef.id, { processedFragmentSets, conditionalFragmentSets, warnings: fragmentWarnings });

          // Process conditional fragments for this row across all sets
          for (const [setName, conditionalFragments] of Object.entries(conditionalFragmentSets)) {
            for (const [conditionalKey, template] of Object.entries(conditionalFragments)) {
              // Evaluate the conditional key for this specific row
              const strippedKey = conditionalKey.replace(/^"(.*)"$/, '$1'); // Remove quotes
              let processedKey = strippedKey;

              // Replace {$token} patterns with values for this row
              for (const [tokenName, cleanValue] of Object.entries(cleanTokenValues)) {
                const tokenPattern = new RegExp(`\\{\\$${tokenName}(?:\\|([^}]+))?\\}`, 'g');
                let match;

                while ((match = tokenPattern.exec(processedKey)) !== null) {
                  const fullMatch = match[0];
                  const transformation = match[1] || 'default';
                  const rawValue = rawTokenValues[tokenName] || '';
                  const transformedValue = applyTokenTransformation(rawValue, transformation);

                  processedKey = processedKey.replace(fullMatch, transformedValue);
                  tokenPattern.lastIndex = 0;
                }
              }

              // Evaluate the conditional expression
              const { result, warnings: conditionalWarnings } = processConditionalTemplate(processedKey, cleanTokenValues, suppressWarnings);
              allWarnings.push(...conditionalWarnings);

              // If the condition evaluated to something (not empty/false), include this row
              if (result.trim()) {
                console.log(`[KAHUA] Row evaluation: ${setName}.${conditionalKey} -> "${result.trim()}"`);
                // Add this to regular processed fragments so it gets included in output
                if (!fragmentsByDef.get(fragmentDef.id)!.processedFragmentSets[setName]) {
                  fragmentsByDef.get(fragmentDef.id)!.processedFragmentSets[setName] = {};
                }
                fragmentsByDef.get(fragmentDef.id)!.processedFragmentSets[setName][result.trim()] = template;
                console.log(`[KAHUA] Added to processedFragmentSets[${setName}]:`, Object.keys(fragmentsByDef.get(fragmentDef.id)!.processedFragmentSets[setName]));
              } else {
                console.log(`[KAHUA] Row evaluation: ${setName}.${conditionalKey} -> SKIPPED (empty result)`);
              }
            }
          }
        }
        
        conditionalFragmentsByRow.push({
          tokenValues: { clean: cleanTokenValues, raw: rawTokenValues },
          fragmentsByDef
        });
      }

      // Second pass: process fragment sets, only including conditional fragments that evaluated to true for at least one row
      for (const fragmentDef of selectedFragmentDefs) {
        const fragmentType = fragmentDef.type || 'grouped'; // Default to 'grouped'

        // Collect all fragment sets and their keys that appear in any row for this fragment definition
        const fragmentSetsByName = new Map<string, Map<string, Array<{ rowIndex: number; template: string; tokenValues: { clean: Record<string, string>; raw: Record<string, string> }; warnings: string[] }>>>();

        conditionalFragmentsByRow.forEach((rowData, rowIndex) => {
          const rowFragmentData = rowData.fragmentsByDef.get(fragmentDef.id);
          if (rowFragmentData) {
            allWarnings.push(...rowFragmentData.warnings);

            // Process each fragment set for this row
            for (const [setName, fragmentSet] of Object.entries(rowFragmentData.processedFragmentSets)) {
              if (!fragmentSetsByName.has(setName)) {
                fragmentSetsByName.set(setName, new Map());
              }

              const fragmentRowsByKey = fragmentSetsByName.get(setName)!;

              for (const [key, template] of Object.entries(fragmentSet)) {
                if (!fragmentRowsByKey.has(key)) {
                  fragmentRowsByKey.set(key, []);
                }

                fragmentRowsByKey.get(key)!.push({
                  rowIndex,
                  template,
                  tokenValues: rowData.tokenValues,
                  warnings: rowFragmentData.warnings
                });
              }
            }
          }
        });

        // Process each fragment set
        for (const [setName, fragmentRowsByKey] of fragmentSetsByName.entries()) {
          const setDisplayName = setName === 'default' ? fragmentDef.name : `${fragmentDef.name} - ${setName}`;

          if (fragmentType === 'table') {
            // Table type uses header/body/footer structure
            if (!(setDisplayName in structuredFragments)) {
              structuredFragments[setDisplayName] = { 'default': { body: [] } };
            }

            const groupKey = 'default';
            if (!structuredFragments[setDisplayName][groupKey]) {
              structuredFragments[setDisplayName][groupKey] = { body: [] };
            }

            // Process header (only once per group per set)
            const headerRows = fragmentRowsByKey.get('header');
            if (headerRows && headerRows.length > 0 && !structuredFragments[setDisplayName][groupKey].header) {
              const firstHeaderRow = headerRows[0];
              const rendered = renderTemplate(firstHeaderRow.template, firstHeaderRow.tokenValues.clean, firstHeaderRow.tokenValues.raw, suppressWarnings);
              structuredFragments[setDisplayName][groupKey].header = rendered.result;
              allWarnings.push(...rendered.warnings);
            }

            // Process body - only include rows where conditional evaluated to true
            const bodyRows = fragmentRowsByKey.get('body');
            if (bodyRows) {
              for (const rowData of bodyRows) {
                const rendered = renderTemplate(rowData.template, rowData.tokenValues.clean, rowData.tokenValues.raw, suppressWarnings);
                structuredFragments[setDisplayName][groupKey].body.push(rendered.result);
                allWarnings.push(...rendered.warnings);
              }
            }

            // Process nested body fragments
            for (const [key, rows] of fragmentRowsByKey.entries()) {
              if (key.startsWith('body - ')) {
                for (const rowData of rows) {
                  const rendered = renderTemplate(rowData.template, rowData.tokenValues.clean, rowData.tokenValues.raw, suppressWarnings);
                  structuredFragments[setDisplayName][groupKey].body.push(rendered.result);
                  allWarnings.push(...rendered.warnings);
                }
              }
            }

            // Process footer (only once per group per set)
            const footerRows = fragmentRowsByKey.get('footer');
            if (footerRows && footerRows.length > 0) {
              const lastFooterRow = footerRows[footerRows.length - 1];
              const rendered = renderTemplate(lastFooterRow.template, lastFooterRow.tokenValues.clean, lastFooterRow.tokenValues.raw, suppressWarnings);
              structuredFragments[setDisplayName][groupKey].footer = rendered.result;
              allWarnings.push(...rendered.warnings);
            }
          } else {
            // Grouped type - only create section if at least one row evaluated to true
            if (!(setDisplayName in groupedFragments)) {
              groupedFragments[setDisplayName] = {};
            }

            for (const [key, rows] of fragmentRowsByKey.entries()) {
              if (rows.length > 0) { // Only create section if at least one row evaluated to true
                if (!groupedFragments[setDisplayName][key]) {
                  groupedFragments[setDisplayName][key] = [];
                }

                for (const rowData of rows) {
                  const rendered = renderTemplate(rowData.template, rowData.tokenValues.clean, rowData.tokenValues.raw, suppressWarnings);
                  allWarnings.push(...rendered.warnings);
                  groupedFragments[setDisplayName][key].push(rendered.result);
                }
              }
            }
          }
        }
      }

      // Create token table for this group
      const allTokenNames = [...headerTokens.map(t => t.name), ...tableTokens.map(t => t.name)];
      const tokenTable = createFormattedTokenTable(allTokenNames, groupTokenData, tokenDefaults, groupIndex + 1);

      // Build output for this group
      const groupOutputSections: string[] = [tokenTable];

      // Add structured fragments (table type) — supports multiple groups
      groupOutputSections.push(
        formatFragmentCollection({
          table: structuredFragments,
          grouped: groupedFragments,
          applyFormatting,
          indentSize: xmlIndentSize
        })
      );

      outputSections.push(groupOutputSections.join('\n\n'));
    }

    // Show warnings if any and not suppressed
    if (allWarnings.length > 0 && !suppressWarnings) {
      vscode.window.showWarningMessage(`Kahua: ${allWarnings.join('; ')}`);
    }

    let generatedXml = outputSections.join('\n\n');

    // Apply XML formatting if explicitly enabled
    if (applyFormatting) {
      generatedXml = formatXml(generatedXml, xmlIndentSize);
    }

    // Show quick pick to select output target
    const currentFileUri = editor?.document?.uri;
    const target = await showOutputTargetQuickPick(currentFileUri);

    if (!target) {
      vscode.window.showInformationMessage('Kahua: Generation cancelled');
      return;
    }

    // Handle selected output target
    switch (target.type) {
      case 'currentFile':
        const currentFileResults = await insertXmlIntoFile(target.uri, generatedXml, 'smart', selectedFragmentDefs[0]);
        await openInjectionReport(currentFileResults, target.uri);
        vscode.window.showInformationMessage(
          `Kahua: Generated fragments for ${fragmentIds.join(', ')} inserted into current file`
        );
        break;

      case 'selectFile':
        const selectFileResults = await insertXmlIntoFile(target.uri, generatedXml, 'smart', selectedFragmentDefs[0]);
        const fileName = getWorkspaceRelativePath(target.uri);
        await openInjectionReport(selectFileResults, target.uri);
        vscode.window.showInformationMessage(
          `Kahua: Generated fragments for ${fragmentIds.join(', ')} inserted into ${fileName}`
        );
        break;

      case 'newEditor':
        const newDocument = await vscode.workspace.openTextDocument({
          content: generatedXml,
          language: 'xml'
        });
        await vscode.window.showTextDocument(newDocument, {
          viewColumn: vscode.ViewColumn.Beside,
          preview: false
        });
        vscode.window.showInformationMessage(
          `Kahua: Generated fragments for ${fragmentIds.join(', ')} opened in new editor`
        );
        break;

      case 'clipboard':
        await vscode.env.clipboard.writeText(generatedXml);
        vscode.window.showInformationMessage(
          `Kahua: Generated fragments for ${fragmentIds.join(', ')} copied to clipboard`
        );
        break;
    }

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    vscode.window.showErrorMessage(`Kahua Attribute Generator: ${message}`);
  }
}
