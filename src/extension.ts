import * as vscode from 'vscode';
import { SaxesParser } from 'saxes';
import * as path from 'path';

// SAX-based XML types (replacing DOM types)
interface SaxXmlDocument {
  rootElement: SaxXmlElement;
  
  // DOM compatibility property
  documentElement: SaxXmlElement;
}

interface SaxXmlElement {
  tagName: string;
  attributes: Record<string, string>;
  children: SaxXmlElement[];
  parent: SaxXmlElement | null;
  line: number;
  pathNodes: Array<{ tagName: string; attributes: Record<string, any>; line?: number; }>;
  
  // DOM compatibility properties
  nodeName: string;
  getAttribute(name: string): string | null;
}

// Legacy type aliases for compatibility during transition
type XmlDocument = SaxXmlDocument;
type XmlElement = SaxXmlElement;

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

interface InjectionPathConfig {
  path: string;
  displayAttribute?: string | string[];
}

interface FragmentDefinition {
  id: string;
  name: string;
  type?: 'grouped' | 'table'; // Default is 'grouped'
  tokenReferences: string[];
  applicableDocumentTypes?: string[];
  fragments: Record<string, string | Record<string, string | Record<string, string>>>;
  injectionPaths?: Record<string, string | InjectionPathConfig>;
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

interface DocumentTypeRule {
  kind: 'rootElement' | 'xpathExists' | 'xpathNotExists';
  value?: string;
  xpath?: string;
}

interface DocumentTypeDefinition {
  id: string;
  name: string;
  priority?: number;
  rules: DocumentTypeRule[];
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
  | { type: 'currentFile'; uri: vscode.Uri; insertionStrategy?: InsertionStrategy }
  | { type: 'sourceFile'; uri: vscode.Uri }  // Associated XML file from snippet/template generation
  | { type: 'selectFile'; uri: vscode.Uri; insertionStrategy?: InsertionStrategy }
  | { type: 'newEditor' }
  | { type: 'clipboard' };

/**
 * Map to track which XML file a snippet/template document came from
 * Key: URI of snippet/template document
 * Value: URI of the source XML file
 */
const sourceXmlFileMap = new Map<string, vscode.Uri>();

/**
 * Map to track selected token values that affect injection
 * Key: URI of snippet/template document
 * Value: Map of token name to selected value
 */
const injectionAffectingTokens = new Map<string, Map<string, string>>();

const SOURCE_XML_COMMENT_PREFIX = '// Source XML:';
const SOURCE_XML_URI_PREFIX = '// Source XML URI:';
const SOURCE_METADATA_SCAN_LINES = 20;

/**
 * Map to track document type overrides for non-XML documents (templates/snippets)
 */
const documentTypeOverrides = new Map<string, string>();

/**
 * Map to remember token selections per document/template
 * Key: Document/template URI
 * Value: Map of token name to selected value
 */
const selectedTokenValuesByDocument = new Map<string, Map<string, string>>();

/**
 * Tracks template documents (generated token templates)
 */
const templateDocumentUris = new Set<string>();
const snippetDocumentUris = new Set<string>();

/**
 * Cache of detected document types keyed by URI
 */
const documentTypeCache = new Map<string, string | null>();

/**
 * Performance: Cache for parsed XML documents
 * Key: document URI + content hash
 * Value: parsed XML object
 */
interface XmlCacheEntry {
  dom: XmlDocument;
  contentHash: string;
  timestamp: number;
}

const xmlParseCache = new Map<string, XmlCacheEntry>();
const XML_CACHE_MAX_SIZE = 50;
const XML_CACHE_MAX_AGE = 5 * 60 * 1000; // 5 minutes
const parsedXmlContextCache = new WeakMap<vscode.TextDocument, ParsedXmlContext>();
const templateCache = new Map<string, CompiledTemplate>();
const DEFAULT_STATUS_TEXT = '$(rocket) Kahua Generate';
const STATUS_RESET_DELAY_MS = 5000;
let statusResetTimer: ReturnType<typeof setTimeout> | undefined;

const DOCUMENT_TYPE_CONTEXT_KEY = 'kahua.documentType';
const DOCUMENT_APPLICABLE_CONTEXT_KEY = 'kahua.hasApplicableDocument';
const TEMPLATE_DOCUMENT_CONTEXT_KEY = 'kahua.isTemplateDocument';
const SNIPPET_DOCUMENT_CONTEXT_KEY = 'kahua.isSnippetDocument';
const SELECTION_CONTEXT_KEY = 'kahua.hasValidSelection';
const CAN_GENERATE_TEMPLATES_CONTEXT_KEY = 'kahua.canGenerateTemplates';
const CAN_GENERATE_SNIPPETS_CONTEXT_KEY = 'kahua.canGenerateSnippets';
const TEMPLATE_KIND_CONTEXT_KEY = 'kahua.templateKind';
const SNIPPET_KIND_CONTEXT_KEY = 'kahua.snippetKind';
const HAS_SOURCE_FILE_CONTEXT_KEY = 'kahua.hasSourceFile';

// Performance: Conditional debugging
const DEBUG_MODE = process.env.NODE_ENV === 'development';
const debugLog = DEBUG_MODE ? console.log : () => {};
const debugWarn = DEBUG_MODE ? console.warn : () => {};
const debugError = DEBUG_MODE ? console.error : () => {};
function logDuration(label: string, startTime: number): void {
  debugLog(`[KAHUA] ${label} completed in ${Date.now() - startTime}ms`);
}

let generateStatusBarItem: vscode.StatusBarItem | undefined;
let sourceFileStatusBarItem: vscode.StatusBarItem | undefined;

function setGenerationStatus(message: string, autoReset: boolean = true): void {
  if (!generateStatusBarItem) {
    return;
  }
  generateStatusBarItem.text = `$(rocket) ${message}`;
  generateStatusBarItem.show();
  if (statusResetTimer) {
    clearTimeout(statusResetTimer);
    statusResetTimer = undefined;
  }
  if (autoReset) {
    statusResetTimer = setTimeout(() => resetGenerationStatus(), STATUS_RESET_DELAY_MS);
  }
}

function resetGenerationStatus(): void {
  if (!generateStatusBarItem) {
    return;
  }
  generateStatusBarItem.text = DEFAULT_STATUS_TEXT;
  statusResetTimer = undefined;
}

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
  xmlNodeName: string;          // The actual XML tag name, e.g., "Attribute", "Label"

  openTagLine: number;          // Line number of opening tag
  closeTagLine: number;         // Line number of closing tag
  indentation: string;          // Whitespace prefix for indentation
  isSelfClosing: boolean;       // True if <Tag />
  lastChildLine: number;        // Line number of last child element
  context?: string;             // Context info for disambiguation (e.g., Name="Invoice")
  injectionPath?: string;       // The injection path that found this section
  attributes?: Record<string, any>; // Attributes of the element
  nameAttributeValue?: string;  // Value of the 'Name' attribute if present for this element
  enrichedPath: string;         // The full XPath with element names included
}

interface XPathMatchedElement {
  tagName: string;
  attributes: Record<string, any>;
  nameAttributeValue?: string;
  enrichedPath: string;
  pathNodes: Array<{ tagName: string; attributes: Record<string, any>; line?: number; }>;
}

interface PathLineInfo {
  openLine: number;
  closeLine: number;
  lastChildLine: number;
  indentation: string;
  isSelfClosing: boolean;
}

interface ParsedXmlContext {
  textDocument: vscode.TextDocument;
  version: number;
  contentHash: string;
  elementIndex: Map<string, XPathResolvedElement[]>; // Index of all elements by tag name
  rootElementName: string | null;
}

interface XPathResolvedElement {
  line: number;
  tagName: string;
  attributes: Record<string, string>;
  pathContext: string; // Human-readable path like "App/EntityDefs/EntityDef(RFI)/Attributes"
  ancestorPath: XPathPathNode[]; // Full path from root
  indentation: string;
  isSelfClosing: boolean;
  closeLine?: number;
  lastChildLine?: number;
}

interface XPathPathNode {
  tagName: string;
  attributes: Record<string, string>;
}

interface ConditionalFragmentEntry {
  rawKey: string;
  compiledKey: CompiledTemplate;
  template: string;
}

type CompiledTemplatePart =
  | { type: 'text'; value: string }
  | { type: 'token'; tokenName: string; transform: string }
  | { type: 'interpolation'; tokenName: string; transform: string }
  | {
      type: 'conditional';
      condition: string;
      trueTemplate: CompiledTemplate;
      falseTemplate: CompiledTemplate;
    };

interface CompiledTemplate {
  parts: CompiledTemplatePart[];
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

interface GeneratedFragmentResult {
  generatedXml: string;
  fragmentDefinition: FragmentDefinition;
  tokenDefinitions: TokenNameDefinition[];
}

/* ----------------------------- config helpers ----------------------------- */

function currentResource(): vscode.Uri | undefined {
  return vscode.window.activeTextEditor?.document?.uri
      ?? vscode.workspace.workspaceFolders?.[0]?.uri;
}

function getKahuaConfig(resource?: vscode.Uri) {
  return vscode.workspace.getConfiguration('kahua', resource);
}

function isAutoDetectEnabled(resource?: vscode.Uri): boolean {
  const config = getKahuaConfig(resource);
  return config.get<boolean>('autoDetectDocumentType') !== false;
}

interface ElementDisplayConfig {
  defaultOrder: string[];
  exclusions: string[];
  overrides: Record<string, string[]>;
}

const DEFAULT_ELEMENT_DISPLAY_CONFIG: ElementDisplayConfig = {
  defaultOrder: ['Name', 'DisplayName', 'Id'],
  exclusions: ['App'],
  overrides: {
    Table: ['EntityDefName', 'Name'],
    ViewDef: ['DisplayName', 'Name']
  }
};

function getResolvedElementDisplayConfig(): ElementDisplayConfig {
  const configured = getKahuaConfig().get<ElementDisplayConfig>('elementDisplayAttributes');
  const defaultClone = {
    defaultOrder: [...DEFAULT_ELEMENT_DISPLAY_CONFIG.defaultOrder],
    exclusions: [...DEFAULT_ELEMENT_DISPLAY_CONFIG.exclusions],
    overrides: { ...DEFAULT_ELEMENT_DISPLAY_CONFIG.overrides }
  };

  if (!configured) {
    return defaultClone;
  }

  return {
    defaultOrder: configured.defaultOrder?.length ? configured.defaultOrder : defaultClone.defaultOrder,
    exclusions: configured.exclusions?.length ? configured.exclusions : defaultClone.exclusions,
    overrides: configured.overrides ? configured.overrides : defaultClone.overrides
  };
}

function getElementDisplayName(
  tagName: string,
  attributes: Record<string, any>,
  config: ElementDisplayConfig
): { displayName?: string; isExcluded: boolean } {
  debugLog(`[DEBUG] getElementDisplayName: Tag: ${tagName}, Attributes:`, attributes, `Config:`, config);
  // Check if the element is in the exclusion list
  if (config.exclusions.includes(tagName)) {
    return { displayName: undefined, isExcluded: true };
  }

  // Determine which attribute order to use (override or default)
  const attributeOrder = config.overrides[tagName] || config.defaultOrder;
  debugLog(`[DEBUG] getElementDisplayName: Resolved attributeOrder for ${tagName}:`, attributeOrder);

  // Find the first attribute with a non-empty value
  for (const attrName of attributeOrder) {
    const attrValue = attributes[attrName];
    debugLog(`[DEBUG] getElementDisplayName: Checking attr: ${attrName}, Value: ${attrValue}`);
    if (attrValue !== undefined && attrValue !== null && attrValue !== "") {
      return { displayName: String(attrValue), isExcluded: false };
    }
  }

  return { displayName: undefined, isExcluded: false };
}

function elementAttributesToRecord(element: XmlElement | null): Record<string, string> {
  const record: Record<string, string> = {};
  if (!element || !element.attributes) {
    return record;
  }
  
  // SAX: attributes is already a Record<string, string>
  for (const [key, value] of Object.entries(element.attributes)) {
    if (!key.startsWith('xmlns')) {
      record[key] = value ?? '';
    }
  }
  return record;
}

const PLACEHOLDER_ATTRIBUTE_PATTERN = /^\s*(\[[^\]]+\]\s*)+$/;

function isPlaceholderAttributeValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  const normalized = String(value).trim();
  if (!normalized) {
    return false;
  }
  return PLACEHOLDER_ATTRIBUTE_PATTERN.test(normalized);
}

function filterPlaceholderAttributes(attributes: Record<string, any>): Record<string, any> {
  let requiresClone = false;
  for (const value of Object.values(attributes)) {
    if (isPlaceholderAttributeValue(value)) {
      requiresClone = true;
      break;
    }
  }

  if (!requiresClone) {
    return attributes;
  }

  const filtered: Record<string, any> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!isPlaceholderAttributeValue(value)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function getChildElements(element: XmlElement): XmlElement[] {
  // SAX: children is already an array of SaxXmlElement
  return element.children || [];
}



function getDocumentTypeDefinitions(resource?: vscode.Uri): DocumentTypeDefinition[] {
  return getKahuaConfig(resource).get<DocumentTypeDefinition[]>('documentTypes') || [];
}

/**
 * Performance: Simple hash function for content caching
 */
export function simpleHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
}

/**
 * Performance: Cleanup old cache entries
 */
function cleanupXmlCache(): void {
  if (xmlParseCache.size <= XML_CACHE_MAX_SIZE) return;
  
  const now = Date.now();
  const entries = Array.from(xmlParseCache.entries());
  
  // Remove old entries first
  for (const [key, entry] of entries) {
    if (now - entry.timestamp > XML_CACHE_MAX_AGE) {
      xmlParseCache.delete(key);
    }
  }
  
  // If still too large, remove oldest entries
  if (xmlParseCache.size > XML_CACHE_MAX_SIZE) {
    const sortedEntries = entries
      .filter(([key]) => xmlParseCache.has(key)) // Still exists after age cleanup
      .sort(([, a], [, b]) => a.timestamp - b.timestamp);
    
    const toRemove = sortedEntries.slice(0, xmlParseCache.size - XML_CACHE_MAX_SIZE + 10);
    for (const [key] of toRemove) {
      xmlParseCache.delete(key);
    }
  }
}

// Old DOM caching function removed - using unified SAX parser

function getParsedXmlContext(document: vscode.TextDocument): ParsedXmlContext {
  const existing = parsedXmlContextCache.get(document);
  const content = document.getText();
  const contentHash = simpleHash(content);
  
  if (existing && existing.contentHash === contentHash) {
    existing.version = document.version;
    existing.textDocument = document;
    debugLog(`[KAHUA] Reusing parsed XML context for ${document.uri.fsPath}`);
    return existing;
  }
  
  debugLog(`[KAHUA] Building new SAX index for ${document.uri.fsPath}`);
  const context = parseXmlWithSax(document, content);
  
  parsedXmlContextCache.set(document, context);
  debugLog(`[KAHUA] Created new SAX-indexed context for ${document.uri.fsPath}`);
  return context;
}

/**
 * New unified SAX parsing - uses a fast indexing approach
 */
function parseXmlWithSax(document: vscode.TextDocument, content: string): ParsedXmlContext {
  const elementIndex = buildSaxIndex(document, content);

  // Extract root element name from the index
  const rootEntry = elementIndex.get('root');
  const rootElementName = rootEntry && rootEntry.length > 0 ? rootEntry[0].tagName : null;

  return {
    textDocument: document,
    version: document.version,
    contentHash: simpleHash(content),
    elementIndex,
    rootElementName
  };
}

/**
 * Builds a complete index of the XML document in a single pass using a SAX parser.
 * This is the core of the high-performance parsing strategy.
 */
function buildSaxIndex(document: vscode.TextDocument, content: string): Map<string, XPathResolvedElement[]> {
    const index = new Map<string, XPathResolvedElement[]>();
    const parser = new SaxesParser({ xmlns: false, position: true });
    const elementStack: XPathResolvedElement[] = [];

    parser.on('opentag', (tag: any) => {
        const line = Math.max(0, parser.line - 1);
        const indentation = getIndentationForLine(document, line);
        const attributes = saxesAttributesToRecord(tag.attributes as Record<string, { value: string }>);
        
        const parent = elementStack.length > 0 ? elementStack[elementStack.length - 1] : undefined;

        // Construct a human-readable path for context
        const displayName = getElementDisplayNameForIndexing(tag.name, attributes);
        const displaySegment = displayName ? `${tag.name}(${displayName})` : tag.name;
        const pathContext = parent ? `${parent.pathContext}/${displaySegment}` : displaySegment;

        const resolved: XPathResolvedElement = {
            line,
            tagName: tag.name,
            attributes: attributes,
            pathContext: pathContext,
            ancestorPath: [...(parent?.ancestorPath || []), { tagName: tag.name, attributes }],
            indentation,
            isSelfClosing: (tag as any).isSelfClosing || false,
        };

        // Add to index by tag name for fast lookups
        if (!index.has(tag.name)) {
            index.set(tag.name, []);
        }
        index.get(tag.name)!.push(resolved);

        // Add root element to a special 'root' key
        if (!parent) {
            index.set('root', [resolved]);
        }
        
        elementStack.push(resolved);

        if ((tag as any).isSelfClosing) {
            const popped = elementStack.pop();
            if (popped) {
                popped.closeLine = popped.line;
                popped.lastChildLine = popped.line;
            }
        }
    });

    parser.on('closetag', (tag: any) => {
        if (elementStack.length > 0 && elementStack[elementStack.length - 1].tagName === tag.name) {
            const popped = elementStack.pop();
            if (popped) {
                popped.closeLine = Math.max(0, parser.line - 1);
            }
        }
    });

    parser.on('error', error => {
      debugWarn('[KAHUA] SAX parser error during indexing:', error);
    });

    parser.write(content);
    parser.close();
    
    return index;
}

function getElementDisplayNameForIndexing(tagName: string, attributes: Record<string, string>): string | undefined {
    const config = getResolvedElementDisplayConfig();
    const attributeOrder = config.overrides?.[tagName] || config.defaultOrder || ['Name', 'DisplayName', 'Id'];
    
    for (const attrName of attributeOrder) {
      const attrValue = attributes[attrName];
      if (attrValue && attrValue.trim()) {
        return attrValue;
      }
    }
    
    return undefined;
}

function parseXmlForDocumentTypeDetection(text: string): SaxXmlDocument | undefined {
  try {
    let rootElementName: string | null = null;
    const parser = new SaxesParser({ xmlns: false });
    
    parser.on('opentag', (node: any) => {
      if (!rootElementName) {
        rootElementName = node.name;
      }
    });
    
    parser.write(text);
    parser.close();
    
    if (!rootElementName) {
      return undefined;
    }
    
    // Create minimal SAX document for compatibility
    const rootElement: SaxXmlElement = {
      tagName: rootElementName,
      attributes: {},
      children: [],
      parent: null,
      line: 0,
      pathNodes: [],
      nodeName: rootElementName,
      getAttribute: function(name: string) { return null; }
    };
    
    return {
      rootElement,
      documentElement: rootElement
    };
  } catch (error) {
    debugWarn('[KAHUA] Failed to parse XML for document type detection:', error);
    return undefined;
  }
}

function resolveRootElementName(doc: XmlDocument): string | undefined {
  return doc?.documentElement?.nodeName ?? undefined;
}

function hasXmlPath(doc: XmlDocument, xpath: string): boolean {
  if (!doc || !xpath) {
    return false;
  }

  const parts = xpath
    .split('/')
    .map(part => part.trim())
    .filter(Boolean);

  const root = doc.documentElement;
  if (!root) {
    return false;
  }

  let remainingParts = parts.slice();
  if (remainingParts.length && root.tagName === remainingParts[0]) {
    remainingParts = remainingParts.slice(1);
  }

  let currentElements: XmlElement[] = [root];

  for (const part of remainingParts) {
    const attrMatch = part.match(/^([\w.]+)\[@(\w+)='([^']+)'\]$/);
    const tagName = attrMatch ? attrMatch[1] : part;
    const filterAttr = attrMatch ? attrMatch[2] : undefined;
    const filterValue = attrMatch ? attrMatch[3] : undefined;

    const nextLevel: XmlElement[] = [];
    for (const element of currentElements) {
      for (const child of getChildElements(element)) {
        if (child.tagName !== tagName) {
          continue;
        }
        if (filterAttr && child.getAttribute(filterAttr) !== filterValue) {
          continue;
        }
        nextLevel.push(child);
      }
    }

    if (nextLevel.length === 0) {
      return false;
    }
    currentElements = nextLevel;
  }

  return currentElements.length > 0;
}

function evaluateDocumentTypeRule(
  rule: DocumentTypeRule,
  dom: XmlDocument,
  rootElementName?: string
): boolean {
  switch (rule.kind) {
    case 'rootElement':
      if (!rule.value || !rootElementName) {
        return false;
      }
      return rootElementName.toLowerCase() === rule.value.toLowerCase();
    case 'xpathExists':
      return !!(rule.xpath && hasXmlPath(dom, rule.xpath));
    case 'xpathNotExists':
      return !!(rule.xpath) && !hasXmlPath(dom, rule.xpath);
    default:
      return false;
  }
}

function detectDocumentTypeId(document: vscode.TextDocument): string | undefined {
  if (document.languageId !== 'xml') {
    const override = documentTypeOverrides.get(document.uri.toString());
    debugLog(`[KAHUA] detectDocumentTypeId: Non-XML document ${document.uri.fsPath}, override=${override}`);
    return override;
  }

  const definitions = getDocumentTypeDefinitions(document.uri);
  if (!definitions.length) {
    debugLog('[KAHUA] detectDocumentTypeId: No document types configured.');
    return undefined;
  }

  const parsedXml = parseXmlForDocumentTypeDetection(document.getText());
  if (!parsedXml) {
    debugLog('[KAHUA] detectDocumentTypeId: Failed to parse XML.');
    return undefined;
  }

  const rootName = resolveRootElementName(parsedXml);
  debugLog(`[KAHUA] detectDocumentTypeId: root=${rootName}`);

  const sortedDefinitions = [...definitions].sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0)
  );

  for (const definition of sortedDefinitions) {
    if (!definition.rules || definition.rules.length === 0) {
      continue;
    }

    const matches = definition.rules.every(rule =>
      evaluateDocumentTypeRule(rule, parsedXml, rootName)
    );

    if (matches) {
      debugLog(`[KAHUA] detectDocumentTypeId: Matched document type ${definition.id} for ${document.uri.fsPath}`);
      return definition.id;
    }
    debugLog(`[KAHUA] detectDocumentTypeId: Document type ${definition.id} did not match.`);
  }

  debugLog('[KAHUA] detectDocumentTypeId: No type matched this document.');
  return undefined;
}

function cacheDocumentType(document: vscode.TextDocument, typeId: string | undefined): string | undefined {
  const key = document.uri.toString();
  documentTypeCache.set(key, typeId ?? null);
  return typeId;
}

function getOrDetectDocumentType(document: vscode.TextDocument): string | undefined {
  const override = documentTypeOverrides.get(document.uri.toString());
  if (override) {
    return override;
  }

  const key = document.uri.toString();
  if (documentTypeCache.has(key)) {
    return documentTypeCache.get(key) ?? undefined;
  }

  const detected = detectDocumentTypeId(document);
  cacheDocumentType(document, detected);
  return detected;
}

async function refreshDocumentTypeForDocument(document: vscode.TextDocument): Promise<string | undefined> {
  const detected = detectDocumentTypeId(document);
  cacheDocumentType(document, detected);
  debugLog(`[KAHUA] refreshDocumentTypeForDocument: ${document.uri.fsPath} -> ${detected}`);
  if (document === vscode.window.activeTextEditor?.document) {
    await setDocumentTypeContext(detected);
  }
  return detected;
}

async function setDocumentTypeContext(typeId?: string): Promise<void> {
  debugLog(`[KAHUA] setDocumentTypeContext: ${typeId ?? 'undefined'}`);
  await vscode.commands.executeCommand(
    'setContext',
    DOCUMENT_APPLICABLE_CONTEXT_KEY,
    Boolean(typeId)
  );
  await vscode.commands.executeCommand(
    'setContext',
    DOCUMENT_TYPE_CONTEXT_KEY,
    typeId ?? ''
  );
}

async function updateDocumentTypeContext(document?: vscode.TextDocument): Promise<void> {
  if (!document) {
    debugLog('[KAHUA] updateDocumentTypeContext: No active document');
    await setDocumentTypeContext(undefined);
    await setTemplateDocumentContext(undefined);
    await setSnippetDocumentContext(undefined);
    await setSelectionContext(undefined);
    await updateGenerationAvailability(undefined);
    await setSourceFileContext(undefined);
    return;
  }

  await setSnippetDocumentContext(document);
  await setTemplateDocumentContext(document);
  if (document === vscode.window.activeTextEditor?.document) {
    await setSelectionContext(vscode.window.activeTextEditor);
  }
  await updateGenerationAvailability(document);
  await setSourceFileContext(document);

  const override = documentTypeOverrides.get(document.uri.toString());
  if (override) {
    debugLog(`[KAHUA] updateDocumentTypeContext: Using override ${override} for ${document.uri.fsPath}`);
    await setDocumentTypeContext(override);
    return;
  }

  if (document.languageId !== 'xml') {
    debugLog(`[KAHUA] updateDocumentTypeContext: Document ${document.uri.fsPath} is not XML`);
    await setDocumentTypeContext(undefined);
    return;
  }

  const typeId = getOrDetectDocumentType(document);
  debugLog(`[KAHUA] updateDocumentTypeContext: Detected type ${typeId} for ${document.uri.fsPath}`);
  await setDocumentTypeContext(typeId);
}

function requireDocumentType(document: vscode.TextDocument): string {
  const typeId = getOrDetectDocumentType(document);
  if (!typeId) {
    throw new Error('Could not determine the document type. Please update kahua.documentTypes or open a supported XML file.');
  }
  return typeId;
}

function isFragmentApplicableToDocument(fragment: FragmentDefinition, documentType: string): boolean {
  return !fragment.applicableDocumentTypes || fragment.applicableDocumentTypes.includes(documentType);
}

function enforceFragmentApplicability(
  fragments: FragmentDefinition[],
  documentType: string
): FragmentDefinition[] {
  const incompatible = fragments.filter(
    fragment => fragment.applicableDocumentTypes && !fragment.applicableDocumentTypes.includes(documentType)
  );

  if (incompatible.length > 0) {
    const names = incompatible.map(f => f.name || f.id).join(', ');
    throw new Error(`Fragment(s) not available for document type "${documentType}": ${names}.`);
  }

  return fragments;
}

function isTemplateDocument(document?: vscode.TextDocument): boolean {
  if (!document) {
    return false;
  }
  if (templateDocumentUris.has(document.uri.toString())) {
    return true;
  }
  return looksLikeTemplateDocument(document);
}

function isSnippetDocument(document?: vscode.TextDocument): boolean {
  if (!document) {
    return false;
  }
  if (snippetDocumentUris.has(document.uri.toString())) {
    return true;
  }
  return looksLikeSnippetDocument(document);
}

function looksLikeTemplateDocument(document: vscode.TextDocument): boolean {
  for (let i = 0; i < Math.min(10, document.lineCount); i++) {
    const text = document.lineAt(i).text.trim();
    if (!text) {
      continue;
    }
    const normalized = text.toLowerCase();
    return normalized.startsWith('// token template for ') || normalized.startsWith('// kahua template for ');
  }
  return false;
}

function looksLikeSnippetDocument(document: vscode.TextDocument): boolean {
  for (let i = 0; i < Math.min(10, document.lineCount); i++) {
    const text = document.lineAt(i).text.trim();
    if (!text) {
      continue;
    }
    return text.toLowerCase().startsWith('// kahua snippet for ');
  }
  return false;
}

function detectTemplateKind(document: vscode.TextDocument): string | undefined {
  for (let i = 0; i < Math.min(10, document.lineCount); i++) {
    const text = document.lineAt(i).text.trim();
    if (!text) {
      continue;
    }
    const match = text.match(/^\/\/\s*(?:kahua\s+)?(?:token\s+)?template\s+for\s+([^:]+):?/i);
    if (match) {
      const raw = match[1].split(/[,&]/)[0].trim();
      return raw.toLowerCase();
    }
  }
  return undefined;
}

function detectSnippetKind(document: vscode.TextDocument): string | undefined {
  for (let i = 0; i < Math.min(10, document.lineCount); i++) {
    const text = document.lineAt(i).text.trim();
    if (!text) {
      continue;
    }
    const match = text.match(/^\/\/\s*kahua\s+snippet\s+for\s+(.+)$/i);
    if (match) {
      const raw = match[1].split(/[,&]/)[0].trim();
      return raw.toLowerCase();
    }
  }
  return undefined;
}

function hasValidFragmentSelection(editor?: vscode.TextEditor | null): boolean {
  if (!editor) {
    return false;
  }
  if (editor.selection.isEmpty) {
    return false;
  }
  const text = editor.document.getText(editor.selection);
  if (!text || text.trim() === '') {
    return false;
  }
  const groups = splitIntoGroups(text);
  return groups.length > 0;
}

async function setTemplateDocumentContext(document?: vscode.TextDocument): Promise<void> {
  const isTemplate = isTemplateDocument(document);
  await vscode.commands.executeCommand(
    'setContext',
    TEMPLATE_DOCUMENT_CONTEXT_KEY,
    isTemplate
  );
  const templateKind = isTemplate && document ? detectTemplateKind(document) : '';
  await vscode.commands.executeCommand(
    'setContext',
    TEMPLATE_KIND_CONTEXT_KEY,
    templateKind ?? ''
  );

  if (generateStatusBarItem) {
    if (isTemplate) {
      generateStatusBarItem.show();
    } else {
      generateStatusBarItem.hide();
    }
  }
}

function markDocumentAsTemplate(document: vscode.TextDocument, documentType: string): void {
  const key = document.uri.toString();
  templateDocumentUris.add(key);
  documentTypeOverrides.set(key, documentType);
  
  // Update context since this document is now a template
  const activeDocument = vscode.window.activeTextEditor?.document;
  if (activeDocument && activeDocument.uri.toString() === key) {
    void setSourceFileContext(activeDocument);
  }
}

function unmarkTemplateDocument(document: vscode.TextDocument): void {
  const key = document.uri.toString();
  templateDocumentUris.delete(key);
  documentTypeOverrides.delete(key);
  selectedTokenValuesByDocument.delete(key);
  injectionAffectingTokens.delete(key);
}

async function setSnippetDocumentContext(document?: vscode.TextDocument): Promise<void> {
  const isSnippet = isSnippetDocument(document);
  await vscode.commands.executeCommand(
    'setContext',
    SNIPPET_DOCUMENT_CONTEXT_KEY,
    isSnippet
  );
  const snippetKind = isSnippet && document ? detectSnippetKind(document) : '';
  await vscode.commands.executeCommand(
    'setContext',
    SNIPPET_KIND_CONTEXT_KEY,
    snippetKind ?? ''
  );
}

async function updateGenerationAvailability(document?: vscode.TextDocument): Promise<void> {
  const canGenerate =
    !!document &&
    document.languageId === 'xml' &&
    !isTemplateDocument(document) &&
    !isSnippetDocument(document);

  await vscode.commands.executeCommand(
    'setContext',
    CAN_GENERATE_TEMPLATES_CONTEXT_KEY,
    canGenerate
  );
  await vscode.commands.executeCommand(
    'setContext',
    CAN_GENERATE_SNIPPETS_CONTEXT_KEY,
    canGenerate
  );
}

function markDocumentAsSnippet(document: vscode.TextDocument, documentType: string): void {
  const key = document.uri.toString();
  snippetDocumentUris.add(key);
  documentTypeOverrides.set(key, documentType);
  
  // Update context since this document is now a snippet
  const activeDocument = vscode.window.activeTextEditor?.document;
  if (activeDocument && activeDocument.uri.toString() === key) {
    void setSourceFileContext(activeDocument);
  }
}

function unmarkSnippetDocument(document: vscode.TextDocument): void {
  const key = document.uri.toString();
  snippetDocumentUris.delete(key);
  documentTypeOverrides.delete(key);
  selectedTokenValuesByDocument.delete(key);
  injectionAffectingTokens.delete(key);
}

async function setSelectionContext(editor?: vscode.TextEditor | null): Promise<void> {
  const hasSelection = hasValidFragmentSelection(editor);
  await vscode.commands.executeCommand(
    'setContext',
    SELECTION_CONTEXT_KEY,
    hasSelection
  );
}

async function setSourceFileContext(document?: vscode.TextDocument): Promise<void> {
  const hasSourceFile = document ? Boolean(getRememberedSourceXmlUri(document)) : false;
  const sourceUri = document ? getRememberedSourceXmlUri(document) : undefined;
  
  debugLog(`[KAHUA] setSourceFileContext: document=${document?.uri.fsPath}, hasSourceFile=${hasSourceFile}, sourceUri=${sourceUri?.fsPath}`);
  
  await vscode.commands.executeCommand(
    'setContext',
    HAS_SOURCE_FILE_CONTEXT_KEY,
    hasSourceFile
  );
  
  // Update source file status bar item
  updateSourceFileStatusBar(sourceUri);
}

function updateSourceFileStatusBar(sourceUri?: vscode.Uri): void {
  if (!sourceFileStatusBarItem) {
    return;
  }
  
  if (sourceUri) {
    const fileName = sourceUri.fsPath.split(/[\\/]/).pop() || sourceUri.fsPath;
    sourceFileStatusBarItem.text = `$(file-code) Kahua Source: ${fileName}`;
    sourceFileStatusBarItem.tooltip = `Source XML File: ${getWorkspaceRelativePath(sourceUri)}\nClick to open source file`;
    sourceFileStatusBarItem.command = {
      command: 'vscode.open',
      arguments: [sourceUri],
      title: 'Open Source File'
    };
    sourceFileStatusBarItem.show();
  } else {
    sourceFileStatusBarItem.hide();
  }
}

function getDefaultFragmentsForDocumentType(documentType: string): string[] {
  switch (documentType) {
    case 'extension':
      return ['attributes'];
    case 'supplement':
      return ['supplements'];
    default:
      return [];
  }
}

function rememberTokenSelectionForUri(uri: vscode.Uri, tokenName: string, value: string): void {
  const key = uri.toString();
  let selections = selectedTokenValuesByDocument.get(key);
  if (!selections) {
    selections = new Map<string, string>();
    selectedTokenValuesByDocument.set(key, selections);
  }
  selections.set(tokenName, value);
}

function rememberTokenSelectionForDocument(document: vscode.TextDocument, tokenName: string, value: string): void {
  rememberTokenSelectionForUri(document.uri, tokenName, value);

  const sourceUri = getRememberedSourceXmlUri(document);
  if (sourceUri) {
    rememberTokenSelectionForUri(sourceUri, tokenName, value);
  }
}

function getStoredTokenSelection(document: vscode.TextDocument, tokenName: string): string | undefined {
  const key = document.uri.toString();
  const direct = selectedTokenValuesByDocument.get(key)?.get(tokenName);
  if (direct) {
    return direct;
  }

  const sourceUri = getRememberedSourceXmlUri(document);
  if (sourceUri) {
    const sourceValue = selectedTokenValuesByDocument.get(sourceUri.toString())?.get(tokenName);
    if (sourceValue) {
      return sourceValue;
    }
  }

  return undefined;
}

function getStoredEntityForDocument(document: vscode.TextDocument): string | undefined {
  return getStoredTokenSelection(document, 'entity');
}

function rememberEntitySelectionForUri(uri: vscode.Uri, entity: string): void {
  rememberTokenSelectionForUri(uri, 'entity', entity);

  const key = uri.toString();
  let affectingTokens = injectionAffectingTokens.get(key);
  if (!affectingTokens) {
    affectingTokens = new Map();
    injectionAffectingTokens.set(key, affectingTokens);
  }
  affectingTokens.set('entity', entity);
}

function rememberEntitySelectionForDocument(document: vscode.TextDocument, entity: string): void {
  rememberEntitySelectionForUri(document.uri, entity);

  const sourceUri = getRememberedSourceXmlUri(document);
  if (sourceUri) {
    rememberEntitySelectionForUri(sourceUri, entity);
  }
}

async function getXmlDocumentForContext(document: vscode.TextDocument): Promise<vscode.TextDocument | undefined> {
  if (document.languageId === 'xml') {
    return document;
  }

  const sourceUri = getRememberedSourceXmlUri(document);
  if (!sourceUri) {
    return undefined;
  }

  try {
    return await vscode.workspace.openTextDocument(sourceUri);
  } catch (error) {
    console.error('[KAHUA] Failed to open source XML document for context:', error);
    return undefined;
  }
}

// Performance: Cache for string transformations
const transformationCache = new Map<string, string>();
const TRANSFORM_CACHE_MAX_SIZE = 1000;

// Performance: Object pool for token value objects
interface TokenValueObject {
  clean: Record<string, string>;
  raw: Record<string, string>;
  reset(): void;
}

class TokenValuePool {
  private pool: TokenValueObject[] = [];
  private maxSize = 100;

  acquire(): TokenValueObject {
    if (this.pool.length > 0) {
      return this.pool.pop()!;
    }
    
    return {
      clean: {},
      raw: {},
      reset() {
        // Clear properties instead of creating new objects
        for (const key in this.clean) {
          delete this.clean[key];
        }
        for (const key in this.raw) {
          delete this.raw[key];
        }
      }
    };
  }

  release(obj: TokenValueObject): void {
    if (this.pool.length < this.maxSize) {
      obj.reset();
      this.pool.push(obj);
    }
  }
}

const tokenValuePool = new TokenValuePool();

/**
 * Performance: Clean transformation cache when it gets too large
 */
function cleanupTransformationCache(): void {
  if (transformationCache.size > TRANSFORM_CACHE_MAX_SIZE) {
    // Remove oldest 25% of entries (simple cleanup strategy)
    const entries = Array.from(transformationCache.entries());
    const toRemove = entries.slice(0, Math.floor(entries.length * 0.25));
    for (const [key] of toRemove) {
      transformationCache.delete(key);
    }
  }
}

/**
 * Converts a token value to PascalCase by removing spaces and special characters
 * and capitalizing the first letter of each word
 * Performance: Cached and optimized string processing
 */
export function toPascalCase(value: string): string {
  if (!value) return value;
  
  // Performance: Check cache first
  const cacheKey = `pascal_${value}`;
  const cached = transformationCache.get(cacheKey);
  if (cached) return cached;

  // Performance: Optimized single-pass processing
  let result = '';
  let capitalizeNext = true;
  
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    const isAlphaNum = /[a-zA-Z0-9]/.test(char);
    
    if (isAlphaNum) {
      if (capitalizeNext) {
        result += char.toUpperCase();
        capitalizeNext = false;
      } else {
        result += char.toLowerCase();
      }
    } else {
      capitalizeNext = true;
    }
  }
  
  // Performance: Cache and return
  cleanupTransformationCache();
  transformationCache.set(cacheKey, result);
  return result;
}

// Performance: Pre-computed lowercase words set for TitleCase
const LOWERCASE_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'yet', 'so',
  'in', 'on', 'at', 'by', 'for', 'of', 'to', 'up', 'as'
]);

/**
 * Converts a token value to TitleCase following standard capitalization rules
 * Performance: Cached and optimized processing
 */
export function toTitleCase(value: string): string {
  if (!value) return value;
  
  // Performance: Check cache first
  const cacheKey = `title_${value}`;
  const cached = transformationCache.get(cacheKey);
  if (cached) return cached;

  // Performance: Single-pass processing with minimal allocations
  let result = '';
  let wordStart = true;
  let isFirstWord = true;
  let wordBuffer = '';
  
  for (let i = 0; i <= value.length; i++) {
    const char = i < value.length ? value[i] : '';
    const isWordChar = /[a-zA-Z0-9]/.test(char);
    
    if (isWordChar) {
      if (wordStart) {
        wordBuffer = char.toUpperCase();
        wordStart = false;
      } else {
        wordBuffer += char.toLowerCase();
      }
    } else {
      if (wordBuffer) {
        // Check if this word should be lowercase (except first word)
        if (!isFirstWord && LOWERCASE_WORDS.has(wordBuffer.toLowerCase())) {
          result += wordBuffer.toLowerCase();
        } else {
          result += wordBuffer;
        }
        wordBuffer = '';
        isFirstWord = false;
      }
      
      if (char) {
        result += char;
        if (/\s/.test(char)) {
          wordStart = true;
        }
      }
    }
  }
  
  // Performance: Cache and return
  cleanupTransformationCache();
  transformationCache.set(cacheKey, result);
  return result;
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

function rememberSourceXmlMapping(documentUri: vscode.Uri, sourceUri: vscode.Uri): void {
  sourceXmlFileMap.set(documentUri.toString(), sourceUri);
  
  // Update context for the document if it's currently active
  const activeDocument = vscode.window.activeTextEditor?.document;
  if (activeDocument && activeDocument.uri.toString() === documentUri.toString()) {
    void setSourceFileContext(activeDocument);
  }
}

function getRememberedSourceXmlUri(document?: vscode.TextDocument): vscode.Uri | undefined {
  if (!document) {
    return undefined;
  }

  const key = document.uri.toString();
  const existing = sourceXmlFileMap.get(key);
  if (existing) {
    return existing;
  }

  const inferred = inferSourceXmlUriFromDocument(document);
  if (inferred) {
    sourceXmlFileMap.set(key, inferred);
    return inferred;
  }

  return undefined;
}

function inferSourceXmlUriFromDocument(document: vscode.TextDocument): vscode.Uri | undefined {
  const maxLines = Math.min(SOURCE_METADATA_SCAN_LINES, document.lineCount);
  for (let i = 0; i < maxLines; i++) {
    const text = document.lineAt(i).text.trim();
    if (!text.startsWith('//')) {
      continue;
    }

    const lower = text.toLowerCase();
    if (lower.startsWith(SOURCE_XML_URI_PREFIX.toLowerCase())) {
      const rawUri = text.substring(SOURCE_XML_URI_PREFIX.length).trim();
      if (!rawUri) {
        continue;
      }
      try {
        return vscode.Uri.parse(rawUri);
      } catch (error) {
        console.warn('[KAHUA] Failed to parse Source XML URI metadata:', error);
      }
    } else if (lower.startsWith(SOURCE_XML_COMMENT_PREFIX.toLowerCase())) {
      const rawPath = text.substring(SOURCE_XML_COMMENT_PREFIX.length).trim();
      if (!rawPath) {
        continue;
      }

      if (path.isAbsolute(rawPath)) {
        return vscode.Uri.file(rawPath);
      }

      const workspaceFolders = vscode.workspace.workspaceFolders || [];
      if (workspaceFolders.length > 0) {
        return vscode.Uri.file(path.join(workspaceFolders[0].uri.fsPath, rawPath));
      }
    }
  }

  return undefined;
}

/**
 * Shows a quick pick menu for selecting where to output generated XML
 */
async function showOutputTargetQuickPick(currentDocument?: vscode.TextDocument): Promise<OutputTarget | undefined> {
  const items: vscode.QuickPickItem[] = [];
  const currentFileUri = currentDocument?.uri;

  // Check if current document has an associated source XML file (from snippet/template generation)
  let targetXmlFile: vscode.Uri | undefined;
  if (currentDocument) {
    targetXmlFile = getRememberedSourceXmlUri(currentDocument);
  } else if (currentFileUri) {
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

  // Option 2: Browse for file (use dialog instead of workspace scan)
  items.push({
    label: `$(folder-opened) Browse for File...`,
    detail: 'Browse for any XML file on your system',
    alwaysShow: true
  });

  // Option 3: New editor tab
  items.push({
    label: `$(new-file) New Editor Tab`,
    detail: 'Open generated XML in a new editor window',
    alwaysShow: true
  });

  // Option 4: Clipboard
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
    return { type: 'sourceFile', uri: targetXmlFile };
  } else if (selected.label.includes('Current File') && currentFileUri) {
    return { type: 'currentFile', uri: currentFileUri };
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
async function insertXmlIntoFile(
  uri: vscode.Uri,
  content: string,
  strategy?: InsertionStrategy,
  fragmentDefinition?: any,
  affectingTokens?: Map<string, string>,
  tokenDefinitions?: TokenNameDefinition[]
): Promise<InjectionResult[]> {
  const document = await vscode.workspace.openTextDocument(uri);
  
  const xmlContext = getParsedXmlContext(document);
  debugLog(`[KAHUA] insertXmlIntoFile: target=${uri.fsPath} strategy=${strategy ?? 'prompt'}`);
  let editor: vscode.TextEditor;
  const existingEditor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());

  if (existingEditor) {
    editor = existingEditor;
    // File is already open, but only show it if it's not the currently active editor
    if (vscode.window.activeTextEditor !== existingEditor) {
      debugLog(`[KAHUA] Bringing existing editor to focus: ${uri.fsPath}`);
      await vscode.window.showTextDocument(existingEditor.document, { preserveFocus: false, preview: false });
    } else {
      debugLog(`[KAHUA] Using already active editor for file: ${uri.fsPath}`);
    }
  } else {
    // File is not open - open it in a new editor
    debugLog(`[KAHUA] Opening new editor for file: ${uri.fsPath}`);
    editor = await vscode.window.showTextDocument(document, {
      preserveFocus: false,
      preview: false
    });
  }

  if (!strategy || strategy === 'cursor') {
    // Simple insertion at cursor position
    const position = editor.selection.active;
    const success = await editor.edit(editBuilder => {
      editBuilder.insert(position, '\n' + content + '\n');
    });

    if (!success) {
      throw new Error(`Kahua: Failed to insert content into ${uri.fsPath}. Please ensure the file is writable and try again.`);
    }

    const lines = content.split('\n').length;
    const newPosition = position.translate(lines + 2, 0);
    editor.selection = new vscode.Selection(newPosition, newPosition);
    return []; // No tracking for cursor mode
  }

  // Smart insertion - get injection paths from the fragment definition
  let injectionPaths: Record<string, string | InjectionPathConfig> = fragmentDefinition?.injectionPaths || {};
  const results: InjectionResult[] = [];

  // Apply injection path templates based on selected token values
  if (affectingTokens && affectingTokens.size > 0 && tokenDefinitions) {
    const modifiedPaths: Record<string, string | InjectionPathConfig> = {};

    for (const [sectionName, pathConfig] of Object.entries(injectionPaths)) {
      const xpath = typeof pathConfig === 'string' ? pathConfig : pathConfig.path;
      const displayAttribute = typeof pathConfig === 'string' ? undefined : pathConfig.displayAttribute;
      let modifiedXPath = xpath;

      // Check each token definition for injection path templates
      for (const tokenDef of tokenDefinitions) {
        if (tokenDef.tokenReadPaths) {
          for (const [tokenName, readPath] of Object.entries(tokenDef.tokenReadPaths)) {
            if (readPath.affectsInjection && readPath.injectionPathTemplate && affectingTokens.has(tokenName)) {
              // Only apply template if the original xpath matches the pattern that the template is for
              // Extract the base path from the template (everything before the filter)
              const templateBasePath = readPath.injectionPathTemplate.split('[')[0];

              // Check if the original xpath starts with or contains the same base path structure
              if (xpath.includes('EntityDef') || xpath === templateBasePath) {
                const tokenValue = affectingTokens.get(tokenName)!;
                modifiedXPath = readPath.injectionPathTemplate.replace('{value}', tokenValue);
                debugLog(`[DEBUG] Applied injection path template to "${sectionName}": ${modifiedXPath} (token: ${tokenName}=${tokenValue})`);
              } else {
                debugLog(`[DEBUG] Skipping injection path template for "${sectionName}" - path "${xpath}" doesn't match template pattern`);
              }
            }
          }
        }
      }

      modifiedPaths[sectionName] = typeof pathConfig === 'string'
        ? modifiedXPath
        : { path: modifiedXPath, ...(displayAttribute && { displayAttribute }) };
    }

    injectionPaths = modifiedPaths;
  }

  debugLog(`[KAHUA] insertXmlIntoFile: starting section mapping (strategy=${strategy ?? 'prompt'})`);
  const generatedSections = parseGeneratedXmlSections(content);
  debugLog(`[KAHUA] insertXmlIntoFile: parsed ${generatedSections.length} generated sections`);
  const parseStart = Date.now();
  const allTargetSections = parseTargetXmlStructure(document, injectionPaths, xmlContext, affectingTokens, tokenDefinitions);
  debugLog(`[KAHUA] insertXmlIntoFile: parseTargetXmlStructure completed in ${Date.now() - parseStart}ms with ${allTargetSections.length} sections`);

  // Deduplicate target sections that point to the same line
  // (happens when multiple section names map to the same xpath)
  const seenLines = new Set<number>();
  const targetSections = allTargetSections.filter(section => {
    if (seenLines.has(section.openTagLine)) {
      debugLog(`[DEBUG] Skipping duplicate target section at line ${section.openTagLine + 1}`);
      return false;
    }
    seenLines.add(section.openTagLine);
    return true;
  });

  const matches = matchSectionsToTargets(generatedSections, targetSections);

  // Determine insertion strategy
  let insertionStrategy: InsertionStrategy;

  if (strategy === 'smart') {
    // Strategy already determined to be smart (e.g., source file or selected file)
    insertionStrategy = 'smart';
  } else {
    // Prompt user for strategy (e.g., current file where cursor position is an option)
    const selectedStrategy = await showInsertionStrategyPick(
      Array.from(matches.values()).some(m => m.length > 0)
    );

    if (!selectedStrategy) {
      return []; // User cancelled
    }

    insertionStrategy = selectedStrategy;
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
  const success = await editor.edit(editBuilder => {
    for (const [sectionName, targets] of selectedTargets.entries()) {
      const genSection = generatedSections.find(s => s.name === sectionName);
      if (!genSection) {
        continue;
      }

      if (targets.length > 0) {
        // Insert into all selected targets
        for (const targetSection of targets) {
          const indentationForContent = targetSection.indentation + '  ';
          const indentedContent = indentContent(
            genSection.content,
            indentationForContent
          );

          let insertPosition: vscode.Position;
          let insertionText: string;

          if (targetSection.isSelfClosing) {
            insertPosition = document.lineAt(targetSection.openTagLine).range.end;
            insertionText = '\n' + indentedContent;
          } else {
            // For non-self-closing tags, insert before the closing tag
            insertPosition = document.lineAt(targetSection.closeTagLine).range.start;
            
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

          editBuilder.insert(
            insertPosition,
            insertionText
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

  if (!success) {
    throw new Error(`Kahua: Failed to update ${uri.fsPath}. Please verify the file is writable and retry.`);
  }

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
  const escapedName = escapeRegExp(tagName);
  const openPattern = new RegExp(`<${escapedName}(?=\\s|>|/)`, 'i');
  const closePattern = new RegExp(`</${escapedName}\\s*>`, 'i');
  const selfClosingPattern = new RegExp(`<${escapedName}(?=\\s|>|/)(?:[^>]*)/>`, 'i');

  let depth = 1;
  for (let i = startLine + 1; i < document.lineCount; i++) {
    const text = document.lineAt(i).text;
    if (selfClosingPattern.test(text)) {
      continue;
    }
    if (openPattern.test(text)) {
      depth++;
    }
    if (closePattern.test(text)) {
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

function parseTargetXmlStructure(
  document: vscode.TextDocument,
  injectionPaths: Record<string, string | InjectionPathConfig>,
  xmlContext: ParsedXmlContext,
  affectingTokens?: Map<string, string>,
  tokenDefinitions?: TokenNameDefinition[]
): XmlTargetSection[] {
  const sections: XmlTargetSection[] = [];
  const config = getResolvedElementDisplayConfig();

  for (const [sectionName, pathConfig] of Object.entries(injectionPaths)) {
    const xpath = typeof pathConfig === 'string' ? pathConfig : pathConfig.path;
    
    const templateApplied = applyInjectionPathTemplate(xpath, affectingTokens || new Map(), tokenDefinitions);
    const finalXpath = templateApplied.result;
    
    const resolvedElements = findElementsByXPath(xmlContext, finalXpath);
    
    for (const element of resolvedElements) {
      const lastPathNode = element.pathNodes[element.pathNodes.length - 1] as (XPathPathNode & { line?: number });
      const line = lastPathNode.line;
      if (line === undefined) continue;

      const lineText = document.lineAt(line).text;
      const indentation = getIndentationForLine(document, line);
      const isSelfClosing = lineText.includes('/>');
      const closeLine = isSelfClosing ? line : findClosingTag(document, element.tagName, line);
      const lastChildLine = isSelfClosing ? line : findLastChildElement(document, line, closeLine);

      sections.push({
        tagName: sectionName,
        xmlNodeName: element.tagName,
        openTagLine: line,
        closeTagLine: closeLine,
        lastChildLine,
        indentation,
        isSelfClosing,
        context: element.enrichedPath,
        injectionPath: finalXpath,
        attributes: element.attributes,
        nameAttributeValue: element.nameAttributeValue,
        enrichedPath: element.enrichedPath
      });
    }
  }

  return sections;
}

/**
 * Finds all target lines using the new indexed XPath search.
 */
function findAllXPathTargets(
  xmlContext: ParsedXmlContext,
  xpath: string
): Array<{line: number, tagName: string, attributes: Record<string, any>, nameAttributeValue?: string, enrichedPath: string, pathNodes: Array<{ tagName: string; attributes: Record<string, any>; line?: number; }>}> {
  debugLog(`[DEBUG] findAllXPathTargets called with xpath: ${xpath}`);

  try {
    const elements = findElementsByXPath(xmlContext, xpath);
    debugLog(`[DEBUG] Found ${elements.length} elements via XPath`);

    if (elements.length === 0) {
      return [];
    }

    const resolvedTargets = elements.map((element: XPathMatchedElement) => {
        const line = findLineNumberForPath(xmlContext, element.pathNodes);
        if (line === -1) {
            debugWarn(`[DEBUG] Unable to locate line for element ${element.tagName} at path ${element.enrichedPath}`);
            return null;
        }
        return {
            line,
            tagName: element.tagName,
            attributes: element.attributes,
            nameAttributeValue: element.nameAttributeValue,
            enrichedPath: element.enrichedPath,
            pathNodes: element.pathNodes
        };
    }).filter((item): item is NonNullable<typeof item> => item !== null);

    debugLog(`[DEBUG] Mapped to ${resolvedTargets.length} line numbers`);
    return resolvedTargets;
  } catch (error) {
    debugWarn(`[ERROR] Failed to parse XML or find elements: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/**
 * Finds the target line for an XPath-like expression in the XML document (first match only)
 */
function findXPathTarget(xmlContext: ParsedXmlContext, xpath: string): number {
  const matches = findAllXPathTargets(xmlContext, xpath);
  return matches.length > 0 ? matches[0].line : -1;
}

/**
 * Finds the line number for a given path of nodes.
 */
function findLineNumberForPath(
  xmlContext: ParsedXmlContext,
  pathNodes: Array<{ tagName: string; attributes: Record<string, any>; line?: number }>
): number {
  if (!pathNodes.length) {
    return -1;
  }
  const lastNode = pathNodes[pathNodes.length - 1];
  // The line number is now stored directly on the node in the index.
  return lastNode.line ?? -1;
}

/**
 * Apply injection path templates with token substitution
 */
export function applyInjectionPathTemplate(
  xpath: string, 
  affectingTokens: Map<string, string>, 
  tokenDefinitions: TokenNameDefinition[] = []
): { success: boolean; result: string } {
  let modifiedXPath = xpath;
  let applied = false;

  for (const tokenDef of tokenDefinitions) {
    if (tokenDef.tokenReadPaths) {
      for (const [tokenName, readPath] of Object.entries(tokenDef.tokenReadPaths)) {
        if (readPath.affectsInjection && readPath.injectionPathTemplate && affectingTokens.has(tokenName)) {
          const templateBasePath = readPath.injectionPathTemplate.split('[')[0];
          const xpathParts = xpath.split('/').filter(p => p);
          let shouldApplyTemplate = false;
          
          if (templateBasePath.includes('EntityDef')) {
            shouldApplyTemplate = xpathParts.some(part => part === 'EntityDef' || (part.startsWith('EntityDef[') && !part.includes('@EntityDefName')));
            if (shouldApplyTemplate && templateBasePath.startsWith('App/') && xpath.startsWith('App/')) {
              const templateStructure = templateBasePath.replace(/\[@[^\]]+\]/g, '');
              const xpathStructure = xpath.replace(/\[@[^\]]+\]/g, '');
              shouldApplyTemplate = xpathStructure.startsWith(templateStructure) || templateStructure.startsWith(xpathStructure);
            }
          } else {
            shouldApplyTemplate = xpath === templateBasePath;
          }
          
          if (shouldApplyTemplate) {
            const tokenValue = affectingTokens.get(tokenName)!;
            modifiedXPath = readPath.injectionPathTemplate.replace('{value}', tokenValue);
            applied = true;
            debugLog(`[DEBUG] Applied injection path template: ${xpath} -> ${modifiedXPath} (token: ${tokenName}=${tokenValue})`);
            break;
          }
        }
      }
    }
  }

  return {
    success: true,
    result: applied ? modifiedXPath : xpath
  };
}

function extractNameAttributeFromRecord(attributes: Record<string, string>, config: ElementDisplayConfig, tagName: string): string | undefined {
  const attributeOrder = config.overrides?.[tagName] || config.defaultOrder || ['Name', 'DisplayName', 'Id'];
  
  for (const attrName of attributeOrder) {
    const attrValue = attributes[attrName];
    if (attrValue && attrValue.trim()) {
      return attrValue;
    }
  }
  
  return undefined;
}

/**
 * Finds elements by XPath using the pre-built SAX index for high performance.
 */
function findElementsByXPath(xmlContext: ParsedXmlContext, xpath: string): XPathMatchedElement[] {
  debugLog(`[DEBUG] findElementsByXPath called with xpath: ${xpath}`);
  
  const parts = xpath.split('/').filter(p => p);
  if (parts.length === 0) {
    return [];
  }

  // The last part of the XPath is the tag we are looking for.
  const targetPart = parts[parts.length - 1];
  const attrMatch = targetPart.match(/^([\w.]+)\[@(\w+)='([^']+)'\]$/);
  const targetTagName = attrMatch ? attrMatch[1] : targetPart;

  // Get all elements with that tag name from the index. This is the main optimization.
  const candidates = xmlContext.elementIndex.get(targetTagName) || [];
  if (candidates.length === 0) {
      return [];
  }

  const results: XPathMatchedElement[] = [];

  for (const candidate of candidates) {
      // Now, verify if the candidate's path matches the full XPath.
      const pathParts = candidate.ancestorPath.map(p => p.tagName);
      
      // This is a simplified path matching logic. It checks if the candidate's path ends with the queried path.
      let match = true;

      if (pathParts.length < parts.length) {
        match = false;
      } else {
        // Compare paths from the end backwards
        for (let i = 0; i < parts.length; i++) {
          const queryPart = parts[parts.length - 1 - i];
          const candidatePart = pathParts[pathParts.length - 1 - i];

          const currentAttrMatch = queryPart.match(/^([\w.]+)\[@(\w+)='([^']+)'\]$/);
          const currentTagName = currentAttrMatch ? currentAttrMatch[1] : queryPart;

          if (currentTagName !== candidatePart) {
            match = false;
            break;
          }

          if (currentAttrMatch) {
            const filterAttrName = currentAttrMatch[2];
            const filterAttrValue = currentAttrMatch[3];
            const nodeAttributes = candidate.ancestorPath[pathParts.length - 1 - i].attributes;
            if (nodeAttributes[filterAttrName] !== filterAttrValue) {
                match = false;
                break;
            }
          }
        }
      }


      if (match) {
          results.push({
              tagName: candidate.tagName,
              attributes: candidate.attributes,
              nameAttributeValue: extractNameAttributeFromRecord(candidate.attributes, getResolvedElementDisplayConfig(), candidate.tagName),
              enrichedPath: candidate.pathContext,
              pathNodes: candidate.ancestorPath.map(p => ({...p, line: candidate.line}))
          });
      }
  }
  
  debugLog(`[DEBUG] Found ${results.length} matches for xpath: ${xpath}`);
  return results;
}


/**
 * Reads from a start position to find a full XML tag, handling multi-line attributes.
 * Returns the full text of the tag (from '<' to '>') and the end position.
 */
function collectFullTag(document: vscode.TextDocument, startOffset: number): { text: string; startPos: vscode.Position; endPos: vscode.Position } | null {
    const textFromStart = document.getText(new vscode.Range(document.positionAt(startOffset), document.positionAt(Infinity)));

    const openAngleOffset = textFromStart.indexOf('<');
    if (openAngleOffset === -1) {
        return null; // No more tags
    }

    const tagStartOffset = startOffset + openAngleOffset;
    const tagStartPos = document.positionAt(tagStartOffset);
    const textFromTagStart = document.getText(new vscode.Range(tagStartPos, document.positionAt(Infinity)));

    let inQuotes = false;
    let quoteChar = '';
    let closeAngleOffset = -1;

    // Find the closing '>' of the tag, respecting quotes
    for (let i = 1; i < textFromTagStart.length; i++) {
        const char = textFromTagStart[i];
        const prevChar = i > 0 ? textFromTagStart[i - 1] : '';

        if ((char === '"' || char === "'") && prevChar !== '\\') {
            if (!inQuotes) {
                inQuotes = true;
                quoteChar = char;
            } else if (char === quoteChar) {
                inQuotes = false;
            }
        } else if (char === '>' && !inQuotes) {
            closeAngleOffset = i;
            break;
        }
    }

    if (closeAngleOffset === -1) {
        return null; // Unclosed tag
    }

    const tagEndOffset = tagStartOffset + closeAngleOffset + 1;
    const tagEndPos = document.positionAt(tagEndOffset);
    const fullTagText = document.getText(new vscode.Range(tagStartPos, tagEndPos));

    return {
        text: fullTagText,
        startPos: tagStartPos,
        endPos: tagEndPos,
    };
}

function getPathNodesCacheKey(pathNodes: Array<{ tagName: string; attributes: Record<string, any> }>): string {
  return pathNodes.map(node => {
    const attrs = node.attributes
      ? Object.keys(node.attributes)
          .sort()
          .map(attr => `${attr}=${String(node.attributes[attr])}`)
          .join('|')
      : '';
    return `${node.tagName}[${attrs}]`;
  }).join('/');
}

// Old findLineNumberForPath function removed - using streaming SAX results with direct line numbers

function saxesAttributesToRecord(attributes: Record<string, { value?: string }> = {}): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, attr] of Object.entries(attributes)) {
    if (key.startsWith('xmlns')) {
      continue;
    }
    record[key] = attr?.value ?? '';
  }
  return record;
}

function getIndentationForLine(document: vscode.TextDocument, line: number): string {
  if (line < 0 || line >= document.lineCount) {
    return '';
  }
  const text = document.lineAt(line).text;
  const match = text.match(/^(\s*)/);
  return match ? match[1] : '';
}

function findLineForNodeInRange(
  document: vscode.TextDocument,
  tagName: string,
  attributes: Record<string, any>,
  startLine: number,
  endLine: number
): number {
    let depth = 0;
    const startOffset = document.offsetAt(new vscode.Position(startLine, 0));
    // Get offset at the start of the line AFTER the end line, to include the whole end line
    const endOffset = document.offsetAt(new vscode.Position(endLine + 1, 0));

    let currentOffset = startOffset;

    while (currentOffset < endOffset) {
        const tagInfo = collectFullTag(document, currentOffset);
        // Ensure the found tag starts within the search range
        if (!tagInfo || document.offsetAt(tagInfo.startPos) >= endOffset) {
            break; // No more tags in range
        }

        const tagLine = tagInfo.startPos.line;
        const tagContent = tagInfo.text.slice(1, -1).trim();

        // Move cursor past this tag for the next iteration
        currentOffset = document.offsetAt(tagInfo.endPos);

        if (!tagContent || tagContent.startsWith('?') || tagContent.startsWith('!')) {
            continue;
        }
        
        // Handle closing tags to decrement depth
        if (tagContent.startsWith('/')) {
            depth = Math.max(0, depth - 1);
            continue;
        }

        // It's an opening or self-closing tag
        const selfClosing = tagContent.endsWith('/');
        const cleanContent = selfClosing ? tagContent.slice(0, -1).trim() : tagContent;

        const nameMatch = cleanContent.match(/^([\w.:-]+)/);
        if (!nameMatch) { 
            if (!selfClosing) {
                depth++;
            }
            continue;
        }

        const name = nameMatch[1];
        // Only log/process if we are within the current search depth
        debugLog(`[KAHUA] inspect line ${tagLine + 1}: <${name}> depth=${depth}`);

        if (depth === 0 && name === tagName) {
            const attrSegment = cleanContent.slice(name.length);
            let matches = true;
            if (Object.keys(attributes).length > 0) {
              for (const [attrName, attrValue] of Object.entries(attributes)) {
                  // Using a more robust regex that handles various whitespace
                  const attrPattern = new RegExp(`${escapeRegExp(attrName)}\\s*=\\s*["']${escapeRegExp(String(attrValue))}["']`, 'i');
                  if (!attrPattern.test(attrSegment)) {
                      matches = false;
                      break;
                  }
              }
            }

            if (matches) {
                debugLog(`[KAHUA]   matched node '${tagName}' on line ${tagLine + 1} at depth ${depth}`);
                return tagLine;
            }
        }

        // If it's an opening tag, increment depth for subsequent nested tags
        if (!selfClosing) {
            depth++;
        }
    }

    // Fallback: use a simpler line-by-line search if structured parsing failed
    const fallbackLine = findLineBySimpleSearch(document, tagName, attributes, startLine, endLine);
    if (fallbackLine !== -1) {
        debugLog(`[KAHUA] Fallback matched <${tagName}> between lines ${startLine + 1}-${endLine + 1}`);
        return fallbackLine;
    }

    return -1;
}

function findLineBySimpleSearch(
  document: vscode.TextDocument,
  tagName: string,
  attributes: Record<string, any>,
  startLine: number,
  endLine: number
): number {
  const attrEntries = Object.entries(attributes);
  const tagPattern = new RegExp(`<${escapeRegExp(tagName)}(?=\\s|>|/)`);

  for (let line = Math.max(0, startLine); line <= Math.min(endLine, document.lineCount - 1); line++) {
    const text = document.lineAt(line).text;
    if (!tagPattern.test(text)) {
      continue;
    }

    let matches = true;
    for (const [attrName, attrValue] of attrEntries) {
      const attrPattern = `${attrName}="`;
      const attrIndex = text.indexOf(attrPattern);
      if (attrIndex === -1) {
        matches = false;
        break;
      }

      const valueStart = attrIndex + attrPattern.length;
      const valueEnd = text.indexOf('"', valueStart);
      const actual = valueEnd === -1 ? text.substring(valueStart) : text.substring(valueStart, valueEnd);
      if (actual !== String(attrValue)) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return line;
    }
  }

  return -1;
}

function collectOpeningTagText(document: vscode.TextDocument, line: number): string | undefined {
  if (line < 0 || line >= document.lineCount) {
    return undefined;
  }

  let text = document.lineAt(line).text;
  if (text.includes('>')) {
    return text;
  }

  let combined = text;
  let currentLine = line + 1;
  while (currentLine < document.lineCount) {
    const nextLine = document.lineAt(currentLine).text;
    combined += nextLine;
    if (nextLine.includes('>')) {
      break;
    }
    currentLine++;
  }

  return combined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extracts an attribute value from XML using XPath
 * Supports paths like "App/@Name" or "EntityDefs/EntityDef/@Name"
 */
function extractAttributeValue(
  document: vscode.TextDocument,
  xpath: string,
  xmlContext?: ParsedXmlContext
): string | undefined {
  if (typeof xpath !== 'string') {
    debugWarn(`[KAHUA] extractAttributeValue: xpath is not string: ${typeof xpath}, value: ${JSON.stringify(xpath)}`);
    return undefined;
  }
  
  if (!xpath.includes('/@')) {
    return undefined;
  }

  const parts = xpath.split('/@');
  const elementPath = parts[0];
  const attributeName = parts[1];

  try {
    const context = xmlContext ?? getParsedXmlContext(document);
    const elements = findElementsByXPath(context, elementPath);

    if (elements.length === 0) {
      return undefined;
    }

    return elements[0].attributes[attributeName];
  } catch (error) {
    debugWarn(`[ERROR] Failed to extract attribute value: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/**
 * Extracts text content from an XML element
 */
function extractTextContent(
  document: vscode.TextDocument,
  xpath: string,
  xmlContext?: ParsedXmlContext
): string | undefined {
  if (typeof xpath !== 'string') {
    debugWarn(`[KAHUA] extractTextContent: xpath is not string: ${typeof xpath}, value: ${JSON.stringify(xpath)}`);
    return undefined;
  }
  
  const context = xmlContext ?? getParsedXmlContext(document);
  const targetLine = findXPathTarget(context, xpath);
  if (targetLine === -1) {
    return undefined;
  }

  const text = document.lineAt(targetLine).text.trim();
  const contentMatch = text.match(/>([^<]+)</);

  return contentMatch ? contentMatch[1] : undefined;
}

/**
 * Finds all elements matching an XPath and extracts their attribute values
 * Returns array of {value, context} for selection UI
 * Filters out elements that don't have the required attribute
 * Uses the configured attribute name for extraction - no hardcoded attributes
 */
function extractSelectableValues(
  document: vscode.TextDocument,
  xpath: string,
  attributeName: string,
  xmlContext?: ParsedXmlContext
): Array<{value: string, context: string}> {
  try {
    const context = xmlContext ?? getParsedXmlContext(document);
    const elements = findElementsByXPath(context, xpath);

    debugLog(`[DEBUG] extractSelectableValues found ${elements.length} elements`);

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
    debugWarn(`[ERROR] Failed to extract selectable values: ${error instanceof Error ? error.message : String(error)}`);
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
  const xmlContext = getParsedXmlContext(document);

  for (const [tokenName, readPath] of Object.entries(tokenReadPaths)) {
    debugLog(`[DEBUG] Processing tokenName: ${tokenName}, readPath.type: ${readPath.type}, readPath.path type: ${typeof readPath.path}, value: ${JSON.stringify(readPath.path)}`);
    
    let value: string | undefined;

    switch (readPath.type) {
      case 'attribute':
        value = extractAttributeValue(document, readPath.path, xmlContext);
        break;

      case 'text':
        value = extractTextContent(document, readPath.path, xmlContext);
        break;

      case 'selection':
        if (!readPath.attribute) {
          debugLog(`[DEBUG] Skipping ${tokenName}: no attribute configured`);
          continue;
        }

        const storedSelection = getStoredTokenSelection(document, tokenName);
        if (storedSelection) {
          debugLog(`[DEBUG] Using stored selection for ${tokenName}: ${storedSelection}`);
          value = storedSelection;
          break;
        }

        debugLog(`[DEBUG] Extracting values for ${tokenName} from path: ${readPath.path}, attribute: ${readPath.attribute}`);
        const options = extractSelectableValues(document, readPath.path, readPath.attribute, xmlContext);
        debugLog(`[DEBUG] Found ${options.length} options:`, options);
        value = await showValueSelectionPick(tokenName, options);
        debugLog(`[DEBUG] User selected: ${value}`);
        if (value) {
          rememberTokenSelectionForDocument(document, tokenName, value);
        }
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
function generateInjectionReport(results: InjectionResult[], targetFileName: string, generationDetails?: string): string {
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

  if (generationDetails) {
    report += `Generation Details:\n`;
    report += `${'-'.repeat(70)}\n`;
    report += generationDetails;
    report += `\n\n`;
  }

  report += `${'='.repeat(70)}\n`;
  report += `End of Report\n`;

  return report;
}

/**
 * Opens a new editor tab with the injection report
 */
async function openInjectionReport(results: InjectionResult[], targetFileUri: vscode.Uri, generationDetails?: string): Promise<void> {
  if (results.length === 0 && generationDetails == undefined) {
    return;
  }

  const targetFileName = getWorkspaceRelativePath(targetFileUri);
  const reportText = generateInjectionReport(results, targetFileName, generationDetails);

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

  const items = targets.map((target, index) => {
    const lineInfo = `Line ${target.openTagLine + 1}`;
    let label = lineInfo;
    let description = target.context && target.context !== lineInfo ? target.context : undefined;
    
    // Enhanced labeling for better disambiguation
    if (target.xmlNodeName === 'HubDef' && target.nameAttributeValue) {
      label = `HubDef: ${target.nameAttributeValue} (${lineInfo})`;
    } else if (target.nameAttributeValue) {
      label = `${target.nameAttributeValue} (${lineInfo})`;
    }
    
    // Add path context to label for better identification
    if (description) {
      // Extract the most relevant parent context for the label
      const pathParts = description.split('/');
      if (pathParts.length > 2) {
        // For EntityDef paths (correct target for Attributes), highlight prominently
        if (description.includes('EntityDefs') || description.includes('EntityDef')) {
          const entityIndex = pathParts.findIndex(part => part.includes('EntityDef'));
          if (entityIndex >= 0) {
            const contextPath = pathParts.slice(entityIndex - 1, entityIndex + 2).join('/');
            label = `🎯 ENTITY: ${contextPath} (${lineInfo}) ← RECOMMENDED`;
          }
        }
        // For DataStore paths, highlight the DataStore context
        else if (description.includes('DataStore')) {
          const dataStoreIndex = pathParts.findIndex(part => part.includes('DataStore'));
          if (dataStoreIndex >= 0 && dataStoreIndex < pathParts.length - 2) {
            const contextPath = pathParts.slice(dataStoreIndex, dataStoreIndex + 3).join('/');
            label = `📊 DataStore: ${contextPath} (${lineInfo})`;
          }
        }
        // For Workflow paths, highlight as potentially incorrect
        else if (description.includes('WorkflowDef')) {
          const workflowIndex = pathParts.findIndex(part => part.includes('WorkflowDef'));
          if (workflowIndex >= 0 && workflowIndex < pathParts.length - 2) {
            const contextPath = pathParts.slice(workflowIndex, workflowIndex + 3).join('/');
            label = `⚠️  Workflow: ${contextPath} (${lineInfo}) ← LIKELY WRONG`;
          }
        }
        // For DataSources paths, mark as wrong for Attributes
        else if (description.includes('DataSources') || description.includes('App.DataSources')) {
          const dataSourceIndex = pathParts.findIndex(part => part.includes('DataSource'));
          if (dataSourceIndex >= 0) {
            const contextPath = pathParts.slice(dataSourceIndex - 1, dataSourceIndex + 3).join('/');
            label = `❌ DataSource: ${contextPath} (${lineInfo}) ← WRONG TARGET`;
          }
        }
        // For other paths, show the last 2-3 relevant parts
        else {
          const contextPath = pathParts.slice(-3).join('/');
          label = `📁 Other: ${contextPath} (${lineInfo})`;
        }
      }
    }

    return {
      label,
      description,
      detail: target.injectionPath,
      target: target,
      picked: false
    };
  });

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
function isSectionConfigured(sectionName: string, injectionPaths: Record<string, string | InjectionPathConfig>): boolean {
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
    const normalizedName = genSection.name.toLowerCase();

    // Extract key words from generated section name
    // e.g., "Extension Attributes - Attributes" -> ["Attributes"]
    const genWords = genSection.name
      .toLowerCase()
      .replace(/extension|supplement|group \d+|default/gi, '')
      .split(/[-\s]+/)
      .filter(w => w.length > 2);

    for (const targetSection of targetSections) {
      const targetName = targetSection.tagName.toLowerCase();
      // First preference: direct match against the target section key
      if (normalizedName.includes(targetName)) {
        allMatches.push(targetSection);
        continue;
      }

      for (const word of genWords) {
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
  conditionalFragmentSets: Record<string, ConditionalFragmentEntry[]>; // setName -> conditional entries
  warnings: string[]
} {
  debugLog('[KAHUA] processFragmentTemplates called with keys:', Object.keys(fragmentTemplates));
  const processedFragmentSets: Record<string, Record<string, string>> = {};
  const conditionalFragmentSets: Record<string, ConditionalFragmentEntry[]> = {};
  const allWarnings: string[] = [];

  // Check if this is the new nested structure (fragment sets) or legacy flat/single-level nested structure
  const hasFragmentSets = Object.values(fragmentTemplates).some(template => isFragmentSet(template));

  if (hasFragmentSets) {
    // New structure: fragments contain sets like { setA: { header: "...", body: "..." }, setB: { ... } }
    for (const [setName, setTemplate] of Object.entries(fragmentTemplates)) {
      if (isFragmentSet(setTemplate)) {
        debugLog('[KAHUA] Processing fragment set:', setName);
        processedFragmentSets[setName] = {};
        conditionalFragmentSets[setName] = [];

        for (const [fragmentKey, template] of Object.entries(setTemplate)) {
          if (typeof template === 'string') {
            if (typeof fragmentKey !== 'string') {
              debugWarn(`[KAHUA] Fragment key is not a string: ${typeof fragmentKey}, value: ${JSON.stringify(fragmentKey)}`);
              continue;
            }
            const strippedKey = fragmentKey.replace(/^"(.*)"$/, '$1');
            const isConditional = strippedKey.match(FRAGMENT_CONDITIONAL_PATTERN);

            if (isConditional) {
              debugLog('[KAHUA] Found conditional in fragment set:', setName, fragmentKey);
              conditionalFragmentSets[setName].push({
                rawKey: strippedKey,
                compiledKey: getCompiledTemplate(strippedKey),
                template
              });
            } else {
              processedFragmentSets[setName][fragmentKey] = template;
            }
          }
        }
      } else {
        // Mixed structure - treat non-fragment-set entries as legacy single set
        debugLog('[KAHUA] Mixed structure detected, processing legacy entry:', setName);
        if (!processedFragmentSets['default']) {
          processedFragmentSets['default'] = {};
          conditionalFragmentSets['default'] = [];
        }

        if (typeof setTemplate === 'object') {
          for (const [subKey, subTemplate] of Object.entries(setTemplate)) {
            if (typeof subKey !== 'string') {
              debugWarn(`[KAHUA] Sub key is not a string: ${typeof subKey}, value: ${JSON.stringify(subKey)}`);
              continue;
            }
            const strippedSubKey = subKey.replace(/^"(.*)"$/, '$1');
            const isConditional = strippedSubKey.match(FRAGMENT_CONDITIONAL_PATTERN);

            if (isConditional) {
              conditionalFragmentSets['default'].push({
                rawKey: strippedSubKey,
                compiledKey: getCompiledTemplate(strippedSubKey),
                template: subTemplate as string
              });
            } else {
              processedFragmentSets['default'][subKey] = subTemplate as string;
            }
          }
        } else {
          if (typeof setName !== 'string') {
            debugWarn(`[KAHUA] Set name is not a string: ${typeof setName}, value: ${JSON.stringify(setName)}`);
            continue;
          }
          const strippedKey = setName.replace(/^"(.*)"$/, '$1');
          const isConditional = strippedKey.match(FRAGMENT_CONDITIONAL_PATTERN);

          if (isConditional) {
            conditionalFragmentSets['default'].push({
              rawKey: strippedKey,
              compiledKey: getCompiledTemplate(strippedKey),
              template: setTemplate
            });
          } else {
            processedFragmentSets['default'][setName] = setTemplate;
          }
        }
      }
    }
  } else {
    // Legacy structure: treat as single default set
    debugLog('[KAHUA] Legacy structure detected, processing as default set');
    processedFragmentSets['default'] = {};
    conditionalFragmentSets['default'] = [];

    for (const [key, template] of Object.entries(fragmentTemplates)) {
      if (typeof template === 'object') {
        // Handle nested structure (like body: { Attributes: "...", Labels: "..." })
        for (const [subKey, subTemplate] of Object.entries(template)) {
          if (typeof subKey !== 'string') {
            debugWarn(`[KAHUA] Nested sub key is not a string: ${typeof subKey}, value: ${JSON.stringify(subKey)}`);
            continue;
          }
          const strippedSubKey = subKey.replace(/^"(.*)"$/, '$1');
          const isConditional = strippedSubKey.match(FRAGMENT_CONDITIONAL_PATTERN);

          if (isConditional) {
            debugLog('[KAHUA] Found conditional in nested structure:', subKey);
            conditionalFragmentSets['default'].push({
              rawKey: strippedSubKey,
              compiledKey: getCompiledTemplate(strippedSubKey),
              template: subTemplate as string
            });
          } else {
            processedFragmentSets['default'][subKey] = subTemplate as string;
          }
        }
      } else {
        // Handle flat structure
        if (typeof key !== 'string') {
          debugWarn(`[KAHUA] Flat key is not a string: ${typeof key}, value: ${JSON.stringify(key)}`);
          continue;
        }
        const strippedKey = key.replace(/^"(.*)"$/, '$1');
        const isConditional = strippedKey.match(FRAGMENT_CONDITIONAL_PATTERN);

        if (isConditional) {
          debugLog('[KAHUA] Found conditional in flat structure:', key);
          conditionalFragmentSets['default'].push({
            rawKey: strippedKey,
            compiledKey: getCompiledTemplate(strippedKey),
            template
          });
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
  debugLog('[KAHUA] activate() called');
  // Set up context menu visibility
  vscode.commands.executeCommand('setContext', 'kahua.showInContextMenu', true);
  vscode.commands.executeCommand('setContext', DOCUMENT_APPLICABLE_CONTEXT_KEY, false);
  vscode.commands.executeCommand('setContext', DOCUMENT_TYPE_CONTEXT_KEY, '');
  vscode.commands.executeCommand('setContext', SELECTION_CONTEXT_KEY, false);
  vscode.commands.executeCommand('setContext', SNIPPET_DOCUMENT_CONTEXT_KEY, false);
  vscode.commands.executeCommand('setContext', TEMPLATE_DOCUMENT_CONTEXT_KEY, false);
  vscode.commands.executeCommand('setContext', CAN_GENERATE_TEMPLATES_CONTEXT_KEY, false);
  vscode.commands.executeCommand('setContext', CAN_GENERATE_SNIPPETS_CONTEXT_KEY, false);
  vscode.commands.executeCommand('setContext', TEMPLATE_KIND_CONTEXT_KEY, '');
  vscode.commands.executeCommand('setContext', SNIPPET_KIND_CONTEXT_KEY, '');
  vscode.commands.executeCommand('setContext', HAS_SOURCE_FILE_CONTEXT_KEY, false);
  generateStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  generateStatusBarItem.text = DEFAULT_STATUS_TEXT;
  generateStatusBarItem.command = 'kahua.generateIntoNewEditor';
  generateStatusBarItem.tooltip = 'Kahua: Generate Entities';
  generateStatusBarItem.hide();
  context.subscriptions.push(generateStatusBarItem);
  
  // Create source file status bar item
  sourceFileStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  sourceFileStatusBarItem.hide();
  context.subscriptions.push(sourceFileStatusBarItem);
  void updateDocumentTypeContext(vscode.window.activeTextEditor?.document);

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      void updateDocumentTypeContext(editor?.document);
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(event => {
      if (event.textEditor === vscode.window.activeTextEditor) {
        void setSelectionContext(event.textEditor);
      }
    })
  );

  // Clean up source XML file map when documents are closed
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument(document => {
      const key = document.uri.toString();
      sourceXmlFileMap.delete(key);
      documentTypeCache.delete(key);
      
      // Performance: Clean up XML cache entries for this document
      const cacheKeysToDelete = Array.from(xmlParseCache.keys()).filter(cacheKey => 
        cacheKey.startsWith(key)
      );
      for (const cacheKey of cacheKeysToDelete) {
        xmlParseCache.delete(cacheKey);
      }
      
      if (templateDocumentUris.has(key)) {
        unmarkTemplateDocument(document);
      } else if (snippetDocumentUris.has(key)) {
        unmarkSnippetDocument(document);
      } else {
        documentTypeOverrides.delete(key);
        selectedTokenValuesByDocument.delete(key);
        injectionAffectingTokens.delete(key);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(document => {
      if (document.languageId === 'xml' && isAutoDetectEnabled(document.uri)) {
        void refreshDocumentTypeForDocument(document);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('kahua.documentTypes')) {
        documentTypeCache.clear();
        void updateDocumentTypeContext(vscode.window.activeTextEditor?.document);
      }

      if (event.affectsConfiguration('kahua.autoDetectDocumentType')) {
        if (isAutoDetectEnabled()) {
          const activeDoc = vscode.window.activeTextEditor?.document;
          if (activeDoc && activeDoc.languageId === 'xml') {
            void refreshDocumentTypeForDocument(activeDoc);
          }
        } else {
          documentTypeCache.clear();
          void setDocumentTypeContext(undefined);
          void setTemplateDocumentContext(undefined);
          void setSnippetDocumentContext(undefined);
        }
      }

    })
  );

  // Register new unified generation commands
  context.subscriptions.push(
    vscode.commands.registerCommand('kahua.showTemplateForGeneration', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('No active editor found.');
        return;
      }

      try {
        const documentType = requireDocumentType(editor.document);
        const pick = await selectFragments('Select fragments for template generation', documentType);
        if (pick) {
          await generateTemplateForFragments(pick.fragments);
        }
      } catch (error: unknown) {
        vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    }),
    vscode.commands.registerCommand('kahua.showSnippetForGeneration', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('No active editor found.');
        return;
      }

      try {
        const documentType = requireDocumentType(editor.document);
        const pick = await selectFragments('Select fragments for snippet generation', documentType);
        if (pick) {
          await generateSnippetForFragments(pick.fragments);
        }
      } catch (error: unknown) {
        vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    }),
    vscode.commands.registerCommand('kahua.generateIntoNewEditor', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || (!isTemplateDocument(editor.document) && !isSnippetDocument(editor.document))) {
        vscode.window.showErrorMessage('This command is only available when editing a template or snippet.');
        return;
      }

      try {
        await generateFromTemplateOrSnippet({ type: 'newEditor' });
      } catch (error: unknown) {
        vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    }),
    vscode.commands.registerCommand('kahua.generateAtCursor', async () => {
      try {
        await generateFromTemplateOrSnippetAtCursor();
      } catch (error: unknown) {
        vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    }),
    vscode.commands.registerCommand('kahua.injectIntoSourceFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || (!isTemplateDocument(editor.document) && !isSnippetDocument(editor.document))) {
        vscode.window.showErrorMessage('This command is only available when editing a template or snippet.');
        return;
      }

      const sourceUri = getRememberedSourceXmlUri(editor.document);
      if (!sourceUri) {
        vscode.window.showErrorMessage('No source XML file found for this template/snippet.');
        return;
      }

      try {
        await generateFromTemplateOrSnippet({ type: 'sourceFile', uri: sourceUri });
      } catch (error: unknown) {
        vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    }),
    vscode.commands.registerCommand('kahua.injectIntoFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || (!isTemplateDocument(editor.document) && !isSnippetDocument(editor.document))) {
        vscode.window.showErrorMessage('This command is only available when editing a template or snippet.');
        return;
      }

      try {
        const browseResult = await vscode.window.showOpenDialog({
          canSelectMany: false,
          canSelectFiles: true,
          canSelectFolders: false,
          filters: {
            'XML Files': ['xml'],
            'All Files': ['*']
          },
          title: 'Select XML File to Inject Into'
        });

        if (!browseResult || browseResult.length === 0) {
          return;
        }

        await generateFromTemplateOrSnippet({ type: 'selectFile', uri: browseResult[0] });
      } catch (error: unknown) {
        vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    })
  );
}

// Performance: Cache for parsed token definitions
const tokenDefinitionCache = new Map<string, ParsedToken[]>();

/**
 * Parses token definitions from configuration string with caching
 * Performance: Reduces repeated string parsing operations
 */
export function parseTokenDefinition(tokens: string): ParsedToken[] {
  // Performance: Check cache first
  const cached = tokenDefinitionCache.get(tokens);
  if (cached) return cached;
  
  // Performance: Single-pass parsing to reduce string allocations
  const result: ParsedToken[] = [];
  const parts = tokens.split(',');
  
  for (let i = 0; i < parts.length; i++) {
    const tokenConfig = parts[i].trim();
    if (!tokenConfig) continue;
    
    const colonIndex = tokenConfig.indexOf(':');
    if (colonIndex === -1) {
      result.push({
        name: tokenConfig,
        defaultValue: ''
      });
    } else {
      result.push({
        name: tokenConfig.slice(0, colonIndex).trim(),
        defaultValue: tokenConfig.slice(colonIndex + 1).trim()
      });
    }
  }
  
  // Performance: Cache the result
  tokenDefinitionCache.set(tokens, result);
  return result;
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
    const trimmed = line.trim();

    if (trimmed === '') {
      if (currentGroup.length > 0) {
        groups.push(currentGroup);
        currentGroup = [];
      }
      continue;
    }

    if (trimmed.startsWith('//')) {
      // Comment line: ignore entirely without affecting current group
      continue;
    }

    currentGroup.push(trimmed);
  }

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
  tokenData: Array<{ clean: Record<string, string>; raw: Record<string, string> }>,
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
      const value = data.raw[tokenName] ?? data.clean[tokenName] ?? '';
      columnWidths[dataIndex + 2] = Math.max(columnWidths[dataIndex + 2], value.length);
    });