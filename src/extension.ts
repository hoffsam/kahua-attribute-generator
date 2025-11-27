import * as vscode from 'vscode';
import { SaxesParser } from 'saxes';
import * as path from 'path';

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
  dom: SaxElement | null;
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
  pathNodes: Array<{ tagName: string; attributes: Record<string, any> }>;
}

interface PathLineInfo {
  openLine: number;
  closeLine: number;
  lastChildLine: number;
  indentation: string;
  isSelfClosing: boolean;
}

interface SaxElement {
  tagName: string;
  attributes: Record<string, string>;
  line: number;
  column: number;
  parent?: SaxElement;
  children: SaxElement[];
  textContent?: string;
  path: string; // XPath-like path to this element
  nameAttributeValue?: string;
  indentation?: string; // Indentation of the opening tag
  isSelfClosing?: boolean;
}

interface ParsedXmlContext {
  textDocument: vscode.TextDocument;
  version: number;
  contentHash: string;
  rootElement: SaxElement | null;
  elementsByPath: Map<string, SaxElement[]>; // XPath -> elements
  xpathElementCache: Map<string, XPathMatchedElement[]>;
  xpathTargetCache: Map<string, Array<{line: number; tagName: string; attributes: Record<string, any>; nameAttributeValue?: string; enrichedPath: string; pathNodes: Array<{ tagName: string; attributes: Record<string, any> }> }>>;
  lineResolutionCache: Map<string, number>;
  pathLineInfo: Map<string, PathLineInfo>;
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
  const configured = getKahuaConfig(undefined).get<ElementDisplayConfig>('elementDisplayAttributes');
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

// Removed: elementAttributesToRecord - SAX elements already have attributes as Record<string, string>

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

// Removed: getChildElements - SAX elements already have children array



function getDocumentTypeDefinitions(resource?: vscode.Uri): DocumentTypeDefinition[] {
  return getKahuaConfig(resource).get<DocumentTypeDefinition[]>('documentTypes') || [];
}

/**
 * Performance: Simple hash function for content caching
 */
// Export functions for testing
export { parseXmlDocumentInternal, extractAttributeValue, extractTextContent, extractSelectableValues, findElementsByXPath, getParsedXmlContext };

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

function getParsedXmlFromCache(document: vscode.TextDocument, content: string, contentHash: string): SaxElement | null {
  const cacheKey = `${document.uri.toString()}_${contentHash}`;
  const cached = xmlParseCache.get(cacheKey);
  if (cached && cached.contentHash === contentHash) {
    cached.timestamp = Date.now();
    return cached.dom;
  }

  const dom = parseXmlDocumentInternal(content);
  cleanupXmlCache();
  xmlParseCache.set(cacheKey, {
    dom,
    contentHash,
    timestamp: Date.now()
  });

  return dom;
}

function buildElementsByPath(rootElement: SaxElement | null): Map<string, SaxElement[]> {
  const elementsByPath = new Map<string, SaxElement[]>();
  
  if (!rootElement) {
    return elementsByPath;
  }

  function traverse(element: SaxElement) {
    const path = element.path;
    
    if (!elementsByPath.has(path)) {
      elementsByPath.set(path, []);
    }
    elementsByPath.get(path)!.push(element);

    // Also add to partial paths for XPath matching
    const pathParts = path.split('/').filter(p => p);
    for (let i = 1; i <= pathParts.length; i++) {
      const partialPath = pathParts.slice(-i).join('/');
      if (!elementsByPath.has(partialPath)) {
        elementsByPath.set(partialPath, []);
      }
      elementsByPath.get(partialPath)!.push(element);
    }

    for (const child of element.children) {
      traverse(child);
    }
  }

  traverse(rootElement);
  return elementsByPath;
}

function getParsedXmlContext(document: vscode.TextDocument): ParsedXmlContext {
  const existing = parsedXmlContextCache.get(document);
  const content = document.getText();
  const contentHash = simpleHash(content);
  let rootElement: SaxElement | null;
  if (existing && existing.contentHash === contentHash) {
    rootElement = existing.rootElement;
  } else {
    rootElement = getParsedXmlFromCache(document, content, contentHash);
  }

  if (existing && existing.contentHash === contentHash) {
    existing.version = document.version;
    existing.textDocument = document;
    existing.rootElement = rootElement;
    debugLog(`[KAHUA] Reusing parsed XML context for ${document.uri.fsPath}`);
    return existing;
  }

  // Build elementsByPath from SAX tree (no need for separate parsing)
  const elementsByPath = buildElementsByPath(rootElement);
  debugLog(`[KAHUA] Built SAX context with ${elementsByPath.size} element paths for ${document.uri.fsPath}`);
  
  const context: ParsedXmlContext = {
    textDocument: document,
    version: document.version,
    contentHash,
    rootElement,
    elementsByPath,
    xpathElementCache: new Map(),
    xpathTargetCache: new Map(),
    lineResolutionCache: new Map(),
    pathLineInfo: new Map() // Simplified - SAX elements have line numbers built-in
  };

  parsedXmlContextCache.set(document, context);
  return context;
}

function parseXmlForDocumentTypeDetection(text: string): SaxElement | null | undefined {
  try {
    // Performance: Check cache first
    const contentHash = simpleHash(text);
    const cacheKey = `doctype_${contentHash}`;
    const cached = xmlParseCache.get(cacheKey);
    
    if (cached && cached.contentHash === contentHash) {
      cached.timestamp = Date.now(); // Update access time
      return cached.dom;
    }

    const dom = parseXmlDocumentInternal(text);
    
    // Performance: Cache the result
    cleanupXmlCache();
    xmlParseCache.set(cacheKey, {
      dom,
      contentHash,
      timestamp: Date.now()
    });
    
    return dom;
  } catch (error) {
    debugWarn('[KAHUA] Failed to parse XML for document type detection:', error);
    return undefined;
  }
}

function resolveRootElementName(rootElement: SaxElement | null | undefined): string | undefined {
  return rootElement?.tagName ?? undefined;
}

function hasXmlPath(rootElement: SaxElement | null, xpath: string): boolean {
  if (!rootElement || !xpath) {
    return false;
  }

  const parts = xpath
    .split('/')
    .map(part => part.trim())
    .filter(Boolean);

  let remainingParts = parts.slice();
  if (remainingParts.length && rootElement.tagName === remainingParts[0]) {
    remainingParts = remainingParts.slice(1);
  }

  let currentElements: SaxElement[] = [rootElement];

  for (const part of remainingParts) {
    const attrMatch = part.match(/^([\w.]+)\[@(\w+)='([^']+)'\]$/);
    const tagName = attrMatch ? attrMatch[1] : part;
    const filterAttr = attrMatch ? attrMatch[2] : undefined;
    const filterValue = attrMatch ? attrMatch[3] : undefined;

    const nextLevel: SaxElement[] = [];
    for (const element of currentElements) {
      for (const child of element.children) {
        if (child.tagName !== tagName) {
          continue;
        }
        if (filterAttr && child.attributes[filterAttr] !== filterValue) {
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
  rootElement: SaxElement | null | undefined,
  rootElementName?: string
): boolean {
  switch (rule.kind) {
    case 'rootElement':
      if (!rule.value || !rootElementName) {
        return false;
      }
      return rootElementName.toLowerCase() === rule.value.toLowerCase();
    case 'xpathExists':
      return !!(rule.xpath && hasXmlPath(rootElement || null, rule.xpath));
    case 'xpathNotExists':
      return !!(rule.xpath) && !hasXmlPath(rootElement || null, rule.xpath);
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
  debugLog(`[KAHUA] detectDocumentTypeId: Found ${definitions.length} document type definitions`);
  if (!definitions.length) {
    debugLog(`[KAHUA] detectDocumentTypeId: No document types configured for workspace containing ${document.uri.fsPath}`);
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

/**
 * Simplified XML target finding - finds all possible injection points and lets user choose
 * No complex cache matching needed
 */
function parseTargetXmlStructure(
  document: vscode.TextDocument,
  injectionPaths: Record<string, string | InjectionPathConfig>,
  xmlContext: ParsedXmlContext,
  affectingTokens?: Map<string, string>,
  tokenDefinitions?: TokenNameDefinition[]
): XmlTargetSection[] {
  const sections: XmlTargetSection[] = [];

  // Get element display configuration
  const config = getResolvedElementDisplayConfig();

  for (const [sectionName, pathConfig] of Object.entries(injectionPaths)) {
    // Normalize to always have path and displayAttribute(s)
    const xpath = typeof pathConfig === 'string' ? pathConfig : pathConfig.path;
    
    debugLog(`[DEBUG] Processing section "${sectionName}" with xpath: ${xpath}`);

    const templateApplied = applyInjectionPathTemplate(xpath, affectingTokens || new Map(), tokenDefinitions);
    if (!templateApplied.success) {
      debugLog(`[DEBUG] Skipping injection path template for "${sectionName}" - path "${xpath}" doesn't match template pattern`);
      continue;
    }

    const finalXpath = templateApplied.result;
    debugLog(`[DEBUG] Final xpath after template application: ${finalXpath}`);
    
    // Use hierarchical XPath matching - respects exact path structure
    const candidates = findElementsByHierarchicalXPath(xmlContext, finalXpath, config, document);
    debugLog(`[DEBUG] Found ${candidates.length} candidates via hierarchical XPath for section "${sectionName}"`);
    
    if (candidates.length === 0) {
      debugLog(`[DEBUG] No candidates found for xpath: ${finalXpath}`);
      continue;
    }

    // Process each candidate found
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const element = candidate.element;
      
      debugLog(`[DEBUG] Processing candidate ${i + 1}/${candidates.length} for section "${sectionName}": ${candidate.pathSoFar}`);
      
      // Find the line number using simple search
      const line = element.line;
      debugLog(`[DEBUG] Found element at line: ${line + 1} (0-based: ${line})`);
      
      if (line === -1) {
        debugLog(`[DEBUG] Could not locate line for element ${element.tagName} in section "${sectionName}"`);
        continue;
      }
      
      const lineText = document.lineAt(line).text;
      const tagName = element.tagName;
      const indentation = lineText.match(/^(\s*)</)?.[1] || '';
      const isSelfClosing = lineText.includes('/>');
      const closeLine = isSelfClosing ? line : findClosingTag(document, tagName, line);
      const lastChildLine = isSelfClosing ? line : findLastChildElement(document, line, closeLine);

      debugLog(`[DEBUG] Element details - line: ${line + 1}, selfClosing: ${isSelfClosing}, closeLine: ${closeLine + 1}, lastChild: ${lastChildLine + 1}`);

      sections.push({
        tagName: sectionName,  // The section name (e.g., "Attributes")
        xmlNodeName: tagName,  // The XML tag name (e.g., "Attributes") 
        openTagLine: line,
        closeTagLine: closeLine,
        lastChildLine,
        indentation,
        isSelfClosing,
        context: candidate.pathSoFar,  // Use the hierarchical path as context
        injectionPath: finalXpath,
        attributes: element.attributes,
        nameAttributeValue: extractNameAttribute(element, config),
        enrichedPath: candidate.pathSoFar
      });
      
      debugLog(`[DEBUG] Added section for "${sectionName}" at line ${line + 1} with path: ${candidate.pathSoFar}`);
      debugLog(`[DEBUG] Final XPath used: ${finalXpath}, Original XPath: ${xpath}`);
    }
  }

  return sections;
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

  // Check each token definition for injection path templates
  for (const tokenDef of tokenDefinitions) {
    if (tokenDef.tokenReadPaths) {
      for (const [tokenName, readPath] of Object.entries(tokenDef.tokenReadPaths)) {
        if (readPath.affectsInjection && readPath.injectionPathTemplate && affectingTokens.has(tokenName)) {
          // Only apply template if the original xpath matches the pattern that the template is for
          // Extract the base path from the template (everything before the filter)
          const templateBasePath = readPath.injectionPathTemplate.split('[')[0];

          // Check if the original xpath matches the path structure that this template is meant for
          // Parse both paths to compare their structural elements, not just string matching
          const xpathParts = xpath.split('/').filter(p => p);
          const templateParts = templateBasePath.split('/').filter(p => p);
          
          // Check if this template should apply to this xpath by comparing path structure
          let shouldApplyTemplate = false;
          
          // For EntityDef-based templates, check if we're actually targeting EntityDef elements
          if (templateBasePath.includes('EntityDef')) {
            // Only apply if the xpath has EntityDef as a path element (not just in attribute filters)
            shouldApplyTemplate = xpathParts.some(part => {
              // Check if this part is "EntityDef" or "EntityDef[...]" but not "@EntityDefName"
              return part === 'EntityDef' || (part.startsWith('EntityDef[') && !part.includes('@EntityDefName'));
            });
            
            // For absolute paths, also ensure the path structures match
            if (shouldApplyTemplate && templateBasePath.startsWith('App/') && xpath.startsWith('App/')) {
              // Both are absolute paths - check structural compatibility more strictly
              const templateStructure = templateBasePath.replace(/\[@[^\]]+\]/g, ''); // Remove attribute filters
              const xpathStructure = xpath.replace(/\[@[^\]]+\]/g, ''); // Remove attribute filters  
              
              // Check if xpath structure matches template structure (allowing for the target to be more specific)
              shouldApplyTemplate = xpathStructure.startsWith(templateStructure) || templateStructure.startsWith(xpathStructure);
            }
          } else {
            // For other templates, check exact path match
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
    success: true, // Always return success, just use original xpath if no template applied
    result: applied ? modifiedXPath : xpath
  };
}

/**
 * Proper hierarchical XPath traversal - respects exact path structure
 */
function findElementsByHierarchicalXPath(
  xmlContext: ParsedXmlContext, 
  xpath: string,
  config: ElementDisplayConfig,
  document: vscode.TextDocument
): Array<{ element: SaxElement; pathSoFar: string; candidatesAtLevel: Array<{ element: SaxElement; displayName: string; line: number }> }> {
  const root = xmlContext.rootElement;
  if (!root) return [];
  
  debugLog(`[DEBUG] Starting hierarchical XPath traversal for: ${xpath}`);
  
  const parts = xpath.split('/').filter(p => p);
  
  // Check if this is an absolute path (starts with App)
  const isAbsolutePath = parts.length > 0 && parts[0] === 'App';
  
  if (isAbsolutePath) {
    // For absolute paths, ensure we start from the correct root App element
    if (root.tagName !== 'App') {
      debugLog(`[DEBUG] Absolute path requires App root, but document root is ${root.tagName}`);
      return [];
    }
    // Remove "App" from parts since we're starting from the App root
    parts.shift();
    debugLog(`[DEBUG] Using absolute path from App root, remaining parts: ${parts.join('/')}`);
  } else {
    // For relative paths (backwards compatibility), skip root if it matches first part
    if (parts.length && root.tagName === parts[0]) {
      parts.shift();
      debugLog(`[DEBUG] Using relative path, skipping root element ${root.tagName}, remaining parts: ${parts.join('/')}`);
    }
  }
  
  // Start with root element
  let currentCandidates: Array<{ element: SaxElement; pathSoFar: string; candidatesAtLevel: Array<{ element: SaxElement; displayName: string; line: number }> }> = [{ 
    element: root, 
    pathSoFar: root.tagName,
    candidatesAtLevel: []
  }];
  
  // Traverse each level of the XPath
  for (let level = 0; level < parts.length; level++) {
    const part = parts[level];
    const isLastLevel = level === parts.length - 1;
    
    debugLog(`[DEBUG] Processing level ${level + 1}/${parts.length}: "${part}" (isLastLevel: ${isLastLevel})`);
    
    // Parse part (handle [@attr='value'] syntax if needed)
    const attrMatch = part.match(/^([\w.]+)\[@(\w+)='([^']+)'\]$/);
    const tagName = attrMatch ? attrMatch[1] : part;
    const filterAttr = attrMatch ? attrMatch[2] : undefined;
    const filterValue = attrMatch ? attrMatch[3] : undefined;
    
    debugLog(`[DEBUG] Looking for tagName: ${tagName}, filterAttr: ${filterAttr}, filterValue: ${filterValue}`);
    
    const nextCandidates: Array<{ element: SaxElement; pathSoFar: string; candidatesAtLevel: Array<{ element: SaxElement; displayName: string; line: number }> }> = [];
    
    for (const candidate of currentCandidates) {
      const children = candidate.element.children;
      const matchingChildren: Array<{ element: SaxElement; displayName: string; line: number }> = [];
      
      debugLog(`[DEBUG] Checking ${children.length} children of ${candidate.element.tagName}`);
      
      for (const child of children) {
        if (child.tagName !== tagName) continue;
        
        // Apply attribute filter if specified
        if (filterAttr && filterValue) {
          const attrValue = child.attributes[filterAttr];
          if (attrValue !== filterValue) {
            debugLog(`[DEBUG] Skipping ${child.tagName}: ${filterAttr}="${attrValue}" != "${filterValue}"`);
            continue;
          }
        }
        
        const displayName = getElementDisplayName(child.tagName, child.attributes, config).displayName || child.tagName;
        const line = child.line;
        
        matchingChildren.push({ element: child, displayName, line });
        debugLog(`[DEBUG] Found matching child: ${child.tagName} (${displayName}) at line ${line + 1}`);
      }
      
      if (matchingChildren.length > 0) {
        if (isLastLevel) {
          // This is our target level - we found the injection points
          for (const match of matchingChildren) {
            nextCandidates.push({
              element: match.element,
              pathSoFar: `${candidate.pathSoFar}/${tagName}(${match.displayName})`,
              candidatesAtLevel: matchingChildren // Store all candidates at this level for user selection
            });
          }
        } else {
          // Not the final level - continue traversal with each matching child
          for (const match of matchingChildren) {
            nextCandidates.push({
              element: match.element,
              pathSoFar: `${candidate.pathSoFar}/${tagName}(${match.displayName})`,
              candidatesAtLevel: matchingChildren
            });
          }
        }
      } else {
        debugLog(`[DEBUG] No matching children found for ${tagName} under ${candidate.element.tagName}`);
      }
    }
    
    currentCandidates = nextCandidates;
    debugLog(`[DEBUG] After level ${level + 1}: ${currentCandidates.length} candidates remaining`);
    
    if (currentCandidates.length === 0) {
      debugLog(`[DEBUG] No candidates found at level ${level + 1}, stopping traversal`);
      break;
    }
  }
  
  debugLog(`[DEBUG] Hierarchical XPath traversal complete: found ${currentCandidates.length} final candidates`);
  return currentCandidates;
}

/**
 * Create display label using configured attribute priority
 */
function createElementDisplayLabel(element: SaxElement, config: ElementDisplayConfig): string {
  const tagName = element.tagName;
  const attributes = element.attributes;
  
  // Get attribute order for this element type
  const attributeOrder = config.overrides?.[tagName] || config.defaultOrder || ['Name', 'DisplayName', 'Id'];
  
  // Find first available attribute
  for (const attrName of attributeOrder) {
    const attrValue = attributes[attrName];
    if (attrValue && attrValue.trim()) {
      return `${tagName}: ${attrValue}`;
    }
  }
  
  // No identifying attribute found, just use tag name
  return tagName;
}

/**
 * Extract name attribute using configured priority
 */
function extractNameAttribute(element: SaxElement, config: ElementDisplayConfig): string | undefined {
  const attributes = element.attributes;
  const attributeOrder = config.overrides?.[element.tagName] || config.defaultOrder || ['Name', 'DisplayName', 'Id'];
  
  for (const attrName of attributeOrder) {
    const attrValue = attributes[attrName];
    if (attrValue && attrValue.trim()) {
      return attrValue;
    }
  }
  
  return undefined;
}

/**
 * Find line number of element in document text using simple search
 */
// Removed: findElementLineInDocument - SAX elements have element.line built-in

/**
 * Performance: Get cached parsed XML document or parse and cache
 */
function getCachedParsedXml(document: vscode.TextDocument): SaxElement | null {
  return getParsedXmlContext(document).rootElement;
}

/**
 * Internal XML parsing function using SAX parser
 */
function parseXmlDocumentInternal(xmlContent: string): SaxElement | null {
  const parser = new SaxesParser({ xmlns: false, position: true });
  let rootElement: SaxElement | null = null;
  const elementStack: SaxElement[] = [];
  let currentTextContent = '';

  parser.on('opentag', (tag) => {
    const attributes: Record<string, string> = {};
    
    for (const [key, attr] of Object.entries(tag.attributes)) {
      // SAX attributes are direct string values, not objects
      attributes[key] = String(attr || '');
    }

    // Build path from element stack
    const pathParts = elementStack.map(el => el.tagName);
    pathParts.push(tag.name);
    const path = pathParts.join('/');

    const lineNumber = parser.line - 1; // Convert to 0-based line numbers
    // For document type detection, we don't need indentation info - skip expensive calculation
    const indentation = '';

    const element: SaxElement = {
      tagName: tag.name,
      attributes,
      line: lineNumber,
      column: parser.column,
      parent: elementStack.length > 0 ? elementStack[elementStack.length - 1] : undefined,
      children: [],
      path,
      nameAttributeValue: attributes.Name || attributes.name,
      indentation,
      isSelfClosing: !!(tag as any).isSelfClosing
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

  parser.on('text', (text) => {
    if (text.trim()) {
      currentTextContent += text;
    }
  });

  parser.on('closetag', (name) => {
    const element = elementStack.pop();
    if (element && currentTextContent.trim()) {
      element.textContent = currentTextContent.trim();
    }
    currentTextContent = '';
  });

  parser.on('error', (error) => {
    throw new Error(`XML parsing error: ${error}`);
  });

  const xmlText = xmlContent.replace(/xmlns="[^"]*"/g, '');
  parser.write(xmlText).close();

  if (DEBUG_MODE && rootElement) {
    debugLog('[DEBUG] Parsed XML root:', (rootElement as SaxElement).tagName);
  }

  return rootElement;
}

/**
 * Parse XML document using SAX parser (legacy function, use getCachedParsedXml)
 * @deprecated Use getCachedParsedXml for better performance
 */
function parseXmlDocument(document: vscode.TextDocument): SaxElement | null {
  return getCachedParsedXml(document);
}

/**
 * Traverse parsed XML object to find elements matching XPath using SAX elements
 * Returns elements with their identifying attributes
 */
function findElementsByXPath(xmlContext: ParsedXmlContext, xpath: string): XPathMatchedElement[] {
  debugLog(`[DEBUG] findElementsByXPath: Searching for xpath "${xpath}"`);
  const cached = xmlContext.xpathElementCache.get(xpath);
  if (cached) {
    debugLog(`[DEBUG] findElementsByXPath: Returning cached result with ${cached.length} elements`);
    return cached;
  }

  const config = getResolvedElementDisplayConfig();

  type TraversalResult = {
    element: SaxElement;
    nameAttributeValue?: string;
    currentEnrichedPath: string;
    pathNodes: Array<{ tagName: string; attributes: Record<string, any> }>;
  };

  const root = xmlContext.rootElement;
  if (!root) {
    return [];
  }

  let parts = xpath.split('/').filter(p => p);
  const rootPathAttributes = filterPlaceholderAttributes(root.attributes);
  const { displayName: rootNameAttr, isExcluded: rootIsExcluded } = getElementDisplayName(root.tagName, root.attributes, config);
  const rootSegment = rootIsExcluded || !rootNameAttr ? root.tagName : `${root.tagName} (${rootNameAttr})`;

  let currentElements: TraversalResult[] = [{
    element: root,
    nameAttributeValue: rootNameAttr,
    currentEnrichedPath: `/${rootSegment}`,
    pathNodes: [{ tagName: root.tagName, attributes: rootPathAttributes }]
  }];

  if (parts.length && root.tagName === parts[0]) {
    parts = parts.slice(1);
  }

  for (const part of parts) {
    const attrMatch = part.match(/^([\w.]+)\[@(\w+)='([^']+)'\]$/);
    const tagName = attrMatch ? attrMatch[1] : part;
    const filterAttrName = attrMatch ? attrMatch[2] : undefined;
    const filterAttrValue = attrMatch ? attrMatch[3] : undefined;
    const filterIsPlaceholder = filterAttrValue?.startsWith('[') && filterAttrValue.endsWith(']');

    const nextElements: TraversalResult[] = [];

    for (const current of currentElements) {
      for (const child of current.element.children) {
        if (child.tagName !== tagName) {
          continue;
        }
        if (filterAttrName && filterAttrValue && !filterIsPlaceholder) {
          const attr = child.attributes[filterAttrName];
          if (attr !== filterAttrValue) {
            continue;
          }
        }

        const filteredAttributesForPath = filterPlaceholderAttributes(child.attributes);
        const { displayName, isExcluded } = getElementDisplayName(tagName, child.attributes, config);
        const segment = isExcluded || !displayName ? tagName : `${tagName} (${displayName})`;

        nextElements.push({
          element: child,
          nameAttributeValue: displayName,
          currentEnrichedPath: `${current.currentEnrichedPath}/${segment}`,
          pathNodes: [...current.pathNodes, { tagName, attributes: filteredAttributesForPath }]
        });
      }
    }

    if (nextElements.length === 0) {
      debugLog(`[DEBUG] ❌ No elements found for part: "${part}" in XPath "${xpath}"`);
      return [];
    }

    currentElements = nextElements;
  }

  const results = currentElements.map(res => ({
    tagName: res.element.tagName,
    attributes: res.element.attributes,
    nameAttributeValue: res.nameAttributeValue,
    enrichedPath: res.currentEnrichedPath,
    pathNodes: res.pathNodes
  }));

  xmlContext.xpathElementCache.set(xpath, results);
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

/**
 * Finds the line number for an element using SAX element line info
 * Simplified since SAX elements have accurate line numbers built-in
 */
function findLineNumberForPath(
  xmlContext: ParsedXmlContext,
  pathNodes: Array<{ tagName: string; attributes: Record<string, any> }>
): number {
  if (!pathNodes.length) {
    return -1;
  }

  const cacheKey = getPathNodesCacheKey(pathNodes);
  const cached = xmlContext.lineResolutionCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  // For SAX-based parsing, we can find the element directly and get its line
  // This is much simpler than the old DOM-based approach
  const xpath = pathNodes.map(node => node.tagName).join('/');
  const elements = findElementsByXPath(xmlContext, xpath);
  
  if (elements.length > 0) {
    // Find matching element by attributes
    for (const element of elements) {
      const lastPathNode = pathNodes[pathNodes.length - 1];
      let matches = true;
      for (const [key, value] of Object.entries(lastPathNode.attributes)) {
        if (element.attributes[key] !== value) {
          matches = false;
          break;
        }
      }
      if (matches) {
        // Get line from SAX element in the tree
        const saxElements = xmlContext.elementsByPath.get(xpath) || [];
        for (const saxEl of saxElements) {
          if (saxEl.tagName === element.tagName) {
            xmlContext.lineResolutionCache.set(cacheKey, saxEl.line);
            return saxEl.line;
          }
        }
      }
    }
  }

  throw new Error(`Kahua: Unable to determine insertion point for "${cacheKey}". Element not found in SAX tree.`);
}

// Removed: buildPathLineIndex - No longer needed since SAX elements have built-in line numbers and indentation info

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
 * Finds all target lines for an XPath-like expression in the XML document
 * Uses DOM traversal for accurate XML parsing
 * Returns array of objects with line numbers, tag names, and attributes
 */
function findAllXPathTargets(
  xmlContext: ParsedXmlContext,
  xpath: string
): Array<{line: number, tagName: string, attributes: Record<string, any>, nameAttributeValue?: string, enrichedPath: string, pathNodes: Array<{ tagName: string; attributes: Record<string, any> }>}> {
  const cached = xmlContext.xpathTargetCache.get(xpath);
  if (cached) {
    return cached;
  }

  debugLog(`[DEBUG] findAllXPathTargets called with xpath: ${xpath}`);

  try {
    const elements = findElementsByXPath(xmlContext, xpath);
    debugLog(`[DEBUG] Found ${elements.length} elements via XPath`);

    if (elements.length === 0) {
      xmlContext.xpathTargetCache.set(xpath, []);
      return [];
    }

    const resolvedTargets: Array<{line: number; tagName: string; attributes: Record<string, any>; nameAttributeValue?: string; enrichedPath: string; pathNodes: Array<{ tagName: string; attributes: Record<string, any> }>}> = [];

    for (const element of elements) {
      const line = findLineNumberForPath(xmlContext, element.pathNodes);
      if (line === -1) {
        debugWarn(`[DEBUG] Unable to locate line for element ${element.tagName} at path ${element.enrichedPath}`);
        continue;
      }
      resolvedTargets.push({
        line,
        tagName: element.tagName,
        attributes: element.attributes,
        nameAttributeValue: element.nameAttributeValue,
        enrichedPath: element.enrichedPath,
        pathNodes: element.pathNodes
      });
    }

    debugLog(`[DEBUG] Mapped to ${resolvedTargets.length} line numbers`);
    xmlContext.xpathTargetCache.set(xpath, resolvedTargets);
    return resolvedTargets;
  } catch (error) {
    debugWarn(`[ERROR] Failed to parse XML or find elements: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/**
 * Finds the target line for an XPath-like expression in the XML document (first match only)
 * Supports: TagName, Parent/Child, Parent/Child[@Attr='value']
 */
function findXPathTarget(xmlContext: ParsedXmlContext, xpath: string): number {
  const matches = findAllXPathTargets(xmlContext, xpath);
  return matches.length > 0 ? matches[0].line : -1;
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
  if (!xpath.includes('/@')) {
    return undefined;
  }

  const parts = xpath.split('/@');
  const elementPath = parts[0];
  const attributeName = parts[1];

  try {
    debugLog(`[DEBUG] extractAttributeValue: elementPath=${elementPath}, attributeName=${attributeName}`);
    const context = xmlContext ?? getParsedXmlContext(document);
    const elements = findElementsByXPath(context, elementPath);
    debugLog(`[DEBUG] extractAttributeValue: Found ${elements.length} elements for path ${elementPath}`);

    if (elements.length === 0) {
      debugLog(`[DEBUG] extractAttributeValue: No elements found for path ${elementPath}`);
      return undefined;
    }

    const attrValue = elements[0].attributes[attributeName];
    debugLog(`[DEBUG] extractAttributeValue: Attribute ${attributeName} value = ${attrValue}`);
    return attrValue;
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
  
  let xmlContext: ParsedXmlContext;
  try {
    xmlContext = getParsedXmlContext(document);
  } catch (error) {
    debugLog(`[DEBUG] Failed to parse XML context: ${error instanceof Error ? error.message : String(error)}`);
    return values; // Return empty map if XML parsing fails
  }

  for (const [tokenName, readPath] of Object.entries(tokenReadPaths)) {
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
  });

  // Create header
  const header = '| ' + columns.map((col, i) => col.padEnd(columnWidths[i])).join(' | ') + ' |';
  const separator = '|' + columnWidths.map(width => '-'.repeat(width + 2)).join('|') + '|';

  // Create data rows
  const rows = tokenNames.map(tokenName => {
    const defaultValue = (tokenDefaults[tokenName] || '').padEnd(columnWidths[1]);
    const values = tokenData.map((data, i) => {
      const value = data.raw[tokenName] ?? data.clean[tokenName] ?? '';
      return value.padEnd(columnWidths[i + 2]);
    });
    return '| ' + tokenName.padEnd(columnWidths[0]) + ' | ' + defaultValue + ' | ' + values.join(' | ') + ' |';
  });

  return `<!-- Group ${groupNumber} Token Configuration and Values Table -->\n${header}\n${separator}\n${rows.join('\n')}`;
}

function getCompiledTemplate(template: string): CompiledTemplate {
  const cached = templateCache.get(template);
  if (cached) {
    return cached;
  }
  const compiled = compileTemplate(template);
  templateCache.set(template, compiled);
  return compiled;
}

function compileTemplate(template: string): CompiledTemplate {
  const parts: CompiledTemplatePart[] = [];
  let index = 0;
  const length = template.length;

  while (index < length) {
    if (template.startsWith('{$', index)) {
      const end = template.indexOf('}', index);
      if (end === -1) {
        parts.push({ type: 'text', value: template.slice(index) });
        break;
      }
      const content = template.slice(index + 2, end);
      const [tokenNameRaw, transformRaw] = content.split('|');
      const tokenName = tokenNameRaw.trim();
      if (tokenName) {
        parts.push({
          type: 'token',
          tokenName,
          transform: (transformRaw?.trim() || 'default')
        });
      } else {
        parts.push({ type: 'text', value: template.slice(index, end + 1) });
      }
      index = end + 1;
      continue;
    }

    if (template.startsWith('$(', index)) {
      const end = template.indexOf(')', index);
      if (end === -1) {
        parts.push({ type: 'text', value: template.slice(index) });
        break;
      }
      const content = template.slice(index + 2, end);
      const [tokenNameRaw, transformRaw] = content.split('|');
      const tokenName = tokenNameRaw.trim();
      if (tokenName) {
        parts.push({
          type: 'interpolation',
          tokenName,
          transform: (transformRaw?.trim() || 'default')
        });
      } else {
        parts.push({ type: 'text', value: template.slice(index, end + 1) });
      }
      index = end + 1;
      continue;
    }

    if (template[index] === '{') {
      const closing = findMatchingBrace(template, index);
      if (closing !== -1) {
        const inner = template.slice(index + 1, closing);
        const ternary = findTernaryOperator(inner);
        if (ternary) {
          const trueValue = stripWrappingQuotes(ternary.trueValue);
          const falseValue = stripWrappingQuotes(ternary.falseValue);
          parts.push({
            type: 'conditional',
            condition: ternary.condition,
            trueTemplate: compileTemplate(trueValue),
            falseTemplate: compileTemplate(falseValue)
          });
          index = closing + 1;
          continue;
        }
      }
    }

    const nextSpecial = findNextSpecialIndex(template, index);
    const textValue = template.slice(index, nextSpecial);
    if (textValue) {
      parts.push({ type: 'text', value: textValue });
    }
    index = nextSpecial;
  }

  return { parts };
}

function findNextSpecialIndex(text: string, start: number): number {
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{' || (ch === '$' && i + 1 < text.length && text[i + 1] === '(')) {
      return i;
    }
  }
  return text.length;
}

function findMatchingBrace(text: string, startIndex: number): number {
  let depth = 0;
  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (text.startsWith('{$', i)) {
      const tokenEnd = text.indexOf('}', i);
      if (tokenEnd === -1) {
        return -1;
      }
      i = tokenEnd;
      continue;
    }

    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function stripWrappingQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function resolveConditionalExpression(
  expression: string,
  rawTokenValues: Record<string, string>
): string {
  return expression.replace(/\{\$(\w+)(?:\|([^}]+))?\}/g, (_match, tokenName: string, transform?: string) => {
    const rawValue = rawTokenValues[tokenName] || '';
    return applyTokenTransformation(rawValue, transform?.trim() || 'default');
  });
}

function renderCompiledTemplate(
  compiled: CompiledTemplate,
  cleanTokenValues: Record<string, string>,
  rawTokenValues: Record<string, string>,
  suppressWarnings: boolean
): { result: string; warnings: string[] } {
  const resultParts: string[] = [];
  const warnings: string[] = [];

  for (const part of compiled.parts) {
    switch (part.type) {
      case 'text':
        resultParts.push(part.value);
        break;

      case 'token': {
        const rawValue = rawTokenValues[part.tokenName] || '';
        const transformed = applyTokenTransformation(rawValue, part.transform);
        resultParts.push(transformed);
        break;
      }

      case 'interpolation': {
        const rawValue = rawTokenValues[part.tokenName] || '';
        const transformed = applyTokenTransformation(rawValue, part.transform);
        resultParts.push(transformed);
        break;
      }

      case 'conditional': {
        const resolvedCondition = resolveConditionalExpression(part.condition, rawTokenValues);
        let branch: CompiledTemplate | undefined;
        try {
          const conditionResult = evaluateExpression(resolvedCondition);
          branch = conditionResult ? part.trueTemplate : part.falseTemplate;
        } catch (error) {
          if (!suppressWarnings) {
            warnings.push(`Error evaluating conditional "${part.condition}": ${error}`);
          }
          branch = part.falseTemplate;
        }

        if (branch && branch.parts.length > 0) {
          const renderedBranch = renderCompiledTemplate(branch, cleanTokenValues, rawTokenValues, suppressWarnings);
          resultParts.push(renderedBranch.result);
          warnings.push(...renderedBranch.warnings);
        }
        break;
      }
    }
  }

  return { result: resultParts.join(''), warnings };
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
  const compiled = getCompiledTemplate(template);
  return renderCompiledTemplate(compiled, cleanTokenValues, rawTokenValues, suppressWarnings);
}

/**
 * Shows quickpick for selecting fragments (no filtering - all fragments are equal)
 */
async function selectFragments(
  placeholder: string,
  documentType: string
): Promise<{ label: string; fragments: string[] } | undefined> {
  const config = vscode.workspace.getConfiguration('kahua', undefined);
  const fragmentDefinitions = config.get<FragmentDefinition[]>('fragmentDefinitions') || [];

  if (fragmentDefinitions.length === 0) {
    vscode.window.showErrorMessage('No fragment definitions configured. Please configure kahua.fragmentDefinitions in your settings.');
    return undefined;
  }

  const applicableFragments = fragmentDefinitions.filter(def => isFragmentApplicableToDocument(def, documentType));
  if (applicableFragments.length === 0) {
    vscode.window.showWarningMessage(`No fragments are configured for document type "${documentType}".`);
    return undefined;
  }

  return await vscode.window.showQuickPick(
    applicableFragments.map(def => ({
      label: def.name,
      fragments: [def.id]
    })),
    {
      placeHolder: placeholder,
      title: 'Kahua Fragment Selector'
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

  if (isTemplateDocument(editor.document) || isSnippetDocument(editor.document)) {
    vscode.window.showInformationMessage('Kahua: Generate Snippet commands are only available while editing a source XML file.');
    return;
  }

  try {
    const documentType = requireDocumentType(editor.document);
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
    const selectedFragmentDefsRaw = fragmentDefinitions.filter(def => fragmentIds.includes(def.id));
    if (selectedFragmentDefsRaw.length === 0) {
      throw new Error(`No matching fragment definitions found for: ${fragmentIds.join(', ')}`);
    }
    const selectedFragmentDefs = enforceFragmentApplicability(selectedFragmentDefsRaw, documentType);

    setGenerationStatus('Preparing fragment generation…', false);

    // Collect all unique token references from selected fragments
    const allTokenReferences = new Set<string>();
    selectedFragmentDefs.forEach(def => {
      def.tokenReferences.forEach(ref => allTokenReferences.add(ref));
    });
    debugLog(`[DEBUG] All token references:`, Array.from(allTokenReferences));

    // Merge token definitions based on references
    const { headerTokens, tableTokens } = mergeTokenDefinitions(
      tokenDefinitions,
      Array.from(allTokenReferences)
    );

    // Extract values from source XML if current file is XML
    const extractedValues = new Map<string, string>();
    const sourceFileUri = editor.document.uri;
    const isSourceXmlFile = sourceFileUri.fsPath.toLowerCase().endsWith('.xml');

    debugLog(`[DEBUG] generateSnippetForFragments: isSourceXmlFile=${isSourceXmlFile}, file=${sourceFileUri.fsPath}`);

    if (isSourceXmlFile) {
      // Collect all tokenReadPaths from referenced token definitions
      const referencedTokenDefs = tokenDefinitions.filter(def =>
        allTokenReferences.has(def.id)
      );

      debugLog(`[DEBUG] Found ${referencedTokenDefs.length} referenced token definitions`);

      for (const tokenDef of referencedTokenDefs) {
        debugLog(`[DEBUG] Checking tokenDef: ${tokenDef.id}, hasReadPaths=${!!tokenDef.tokenReadPaths}`);
        if (tokenDef.tokenReadPaths) {
          debugLog(`[DEBUG] Calling readTokenValuesFromXml for ${tokenDef.id}`);
          const values = await readTokenValuesFromXml(editor.document, tokenDef.tokenReadPaths);
          debugLog(`[DEBUG] Got ${values.size} values from readTokenValuesFromXml`);
          values.forEach((value, key) => extractedValues.set(key, value));
        }
      }
    }

    debugLog(`[DEBUG] Total extracted values: ${extractedValues.size}`);

    // Separate header and table token definitions
    const snippetLabel = fragmentIds.join(', ');
    const snippetBodyLines: string[] = [];
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

      snippetBodyLines.push(headerParts.join(''));
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

        snippetBodyLines.push(tableParts.join(''));
      }
    }

    // If no lines were created, show an error
    if (snippetBodyLines.length === 0) {
      throw new Error('No header or table token definitions found.');
    }

    const snippetLines: string[] = [
      `// Kahua Snippet for ${snippetLabel}`
    ];

    // Remember the current XML file if we're in one
    const currentFileUri = editor.document.uri;
    const isCurrentFileXml = currentFileUri.fsPath.toLowerCase().endsWith('.xml');

    if (isCurrentFileXml) {
      snippetLines.push(`${SOURCE_XML_COMMENT_PREFIX} ${getWorkspaceRelativePath(currentFileUri)}`);
      snippetLines.push(`${SOURCE_XML_URI_PREFIX} ${currentFileUri.toString()}`);
    }

    snippetLines.push('');
    snippetLines.push(...snippetBodyLines);

    const snippetText = snippetLines.join('\n');

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
      rememberSourceXmlMapping(newDocument.uri, currentFileUri);

      // Also store token values that affect injection
      const affectingTokens = new Map<string, string>();
      for (const tokenDef of tokenDefinitions) {
        if (tokenDef.tokenReadPaths) {
          for (const [tokenName, readPath] of Object.entries(tokenDef.tokenReadPaths)) {
            if (readPath.affectsInjection && extractedValues.has(tokenName)) {
              affectingTokens.set(tokenName, extractedValues.get(tokenName)!);
            }
          }
        }
      }
    if (affectingTokens.size > 0) {
      injectionAffectingTokens.set(newDocument.uri.toString(), affectingTokens);
    }
    markDocumentAsSnippet(newDocument, documentType);
    void updateDocumentTypeContext(newDocument);
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
    if (!currentEditor) {
      throw new Error('No active editor found.');
    }
    if (isTemplateDocument(currentEditor.document) || isSnippetDocument(currentEditor.document)) {
      throw new Error('Generate Template commands are only available while editing a source XML file.');
    }
    const documentType = requireDocumentType(currentEditor.document);
    
    const currentRes = currentResource();
    console.log(`[KAHUA] Current resource path: ${currentRes?.fsPath || 'undefined'}`);
    console.log(`[KAHUA] Current document path: ${currentEditor.document.uri.fsPath}`);
    
    // Try to get configuration from current resource first, then fall back to extension workspace
    let config = getKahuaConfig(currentRes || undefined);
    let tokenDefinitions = config.get<TokenNameDefinition[]>('tokenNameDefinitions') || [];
    let fragmentDefinitions = config.get<FragmentDefinition[]>('fragmentDefinitions') || [];
    
    // If no configuration found in document's workspace, try extension's workspace
    if (tokenDefinitions.length === 0 && fragmentDefinitions.length === 0) {
      console.log(`[KAHUA] No config in document workspace, trying extension workspace...`);
      
      // Get extension workspace - try first workspace folder that contains this extension
      const workspaceFolders = vscode.workspace.workspaceFolders || [];
      let extensionWorkspace = workspaceFolders.find(folder => 
        folder.name === 'kahua-attribute-generator' || 
        folder.uri.fsPath.includes('kahua-attribute-generator')
      );
      
      // Fallback to first workspace if specific one not found
      if (!extensionWorkspace && workspaceFolders.length > 0) {
        extensionWorkspace = workspaceFolders[0];
      }
      
      if (extensionWorkspace) {
        console.log(`[KAHUA] Trying extension workspace: ${extensionWorkspace.uri.fsPath}`);
        config = getKahuaConfig(extensionWorkspace.uri);
        tokenDefinitions = config.get<TokenNameDefinition[]>('tokenNameDefinitions') || [];
        fragmentDefinitions = config.get<FragmentDefinition[]>('fragmentDefinitions') || [];
      } else {
        // Last resort - try global configuration
        console.log(`[KAHUA] No workspace found, trying global configuration...`);
        config = getKahuaConfig(undefined);
        tokenDefinitions = config.get<TokenNameDefinition[]>('tokenNameDefinitions') || [];
        fragmentDefinitions = config.get<FragmentDefinition[]>('fragmentDefinitions') || [];
      }
    }
    console.log(`[KAHUA] Final config: Found ${tokenDefinitions.length} token definitions, ${fragmentDefinitions.length} fragment definitions`);

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
    const selectedFragmentDefsRaw = fragmentDefinitions.filter(def => fragmentIds.includes(def.id));
    if (selectedFragmentDefsRaw.length === 0) {
      throw new Error(`No matching fragment definitions found for: ${fragmentIds.join(', ')}`);
    }
    const selectedFragmentDefs = enforceFragmentApplicability(selectedFragmentDefsRaw, documentType);

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

    // Extract values from source XML if available
    const extractedValues = new Map<string, string>();
    const sourceXmlDocument = await getXmlDocumentForContext(currentEditor.document);
    const sourceDocUri = sourceXmlDocument?.uri;
    const hasXmlContext = Boolean(sourceXmlDocument);

    debugLog(`[DEBUG] generateTemplateForFragments: hasXmlContext=${hasXmlContext}, file=${sourceDocUri?.fsPath}`);

    if (sourceXmlDocument) {
      const referencedTokenDefs = tokenDefinitions.filter(def =>
        allTokenReferences.has(def.id)
      );
      debugLog(`[DEBUG] Found ${referencedTokenDefs.length} referenced token definitions`);

      for (const tokenDef of referencedTokenDefs) {
        debugLog(`[DEBUG] Checking tokenDef: ${tokenDef.id}, hasReadPaths=${!!tokenDef.tokenReadPaths}`);
        if (tokenDef.tokenReadPaths) {
          try {
            debugLog(`[DEBUG] Calling readTokenValuesFromXml for ${tokenDef.id}`);
            const values = await readTokenValuesFromXml(sourceXmlDocument, tokenDef.tokenReadPaths);
            debugLog(`[DEBUG] Got ${values.size} values from readTokenValuesFromXml`);
            values.forEach((value, key) => extractedValues.set(key, value));
          } catch (tokenError) {
            debugLog(`[DEBUG] Error reading token values for ${tokenDef.id}:`, tokenError instanceof Error ? tokenError.message : String(tokenError));
            // Continue with other tokens even if one fails
          }
        }
      }
    }

    debugLog(`[DEBUG] Total extracted values: ${extractedValues.size}`);

    // Identify entity token if present (header or table token)
    const entityToken = [...headerTokens, ...tableTokens].find(
      token => token.name.toLowerCase() === 'entity'
    );
    debugLog(`[DEBUG] Found entityToken:`, entityToken?.name);
    let selectedEntity = entityToken ? extractedValues.get(entityToken.name) : undefined;
    const storedEntityPreference = getStoredEntityForDocument(currentEditor.document);
    debugLog(`[DEBUG] selectedEntity:`, selectedEntity, 'storedEntityPreference:', storedEntityPreference);
    if (entityToken && storedEntityPreference) {
      extractedValues.set(entityToken.name, storedEntityPreference);
      selectedEntity = storedEntityPreference;
    }

    debugLog(`[DEBUG] Entity selection conditions: entityToken=${!!entityToken}, selectedEntity=${selectedEntity}, hasXmlContext=${hasXmlContext}`);
    if (entityToken && !selectedEntity && sourceXmlDocument) {
      const referencedTokenDefs = tokenDefinitions.filter(def =>
        allTokenReferences.has(def.id)
      );
      const entityReadPath = referencedTokenDefs
        .map((def: TokenNameDefinition) => def.tokenReadPaths?.[entityToken.name])
        .find((readPath?: TokenReadPath) => readPath && readPath.type === 'selection');

      const attributeName = entityReadPath?.attribute || 'Name';
      const configuredPath = entityReadPath?.path;
      let options: Array<{ value: string; context: string }> = [];

      if (configuredPath) {
        options = extractSelectableValues(sourceXmlDocument, configuredPath, attributeName);
      }

      if (options.length === 0) {
        options = extractSelectableValues(sourceXmlDocument, 'EntityDefs/EntityDef', attributeName || 'Name');
      }

      if (options.length > 0) {
        const picked = await showValueSelectionPick(entityToken.name, options);
        if (picked) {
          extractedValues.set(entityToken.name, picked);
          selectedEntity = picked;
          rememberEntitySelectionForDocument(sourceXmlDocument, picked);
        }
      } else {
        debugLog('[DEBUG] No entity options available in source XML document');
      }
    }

    // Remember the current XML file if we're in one
    const currentFileUri = currentEditor?.document.uri;
    const isCurrentFileXml = currentFileUri?.fsPath.toLowerCase().endsWith('.xml');
    const xmlContextUri = sourceDocUri ?? (isCurrentFileXml ? currentFileUri : undefined);

    // Build template text showing all token definitions
    const fragmentLabel = fragmentIds.join(', ');
    const templateLines: string[] = [];
    templateLines.push(`// Kahua Template for ${fragmentLabel}`);
    if (xmlContextUri) {
      templateLines.push(`${SOURCE_XML_COMMENT_PREFIX} ${getWorkspaceRelativePath(xmlContextUri)}`);
      templateLines.push(`${SOURCE_XML_URI_PREFIX} ${xmlContextUri.toString()}`);
    }
    templateLines.push(`// Token Template for ${fragmentLabel}:`);

    if (entityToken) {
      const entityDisplay = selectedEntity || '<Select entity>';
      templateLines.push('// ----------------------------------------------------------------');
      templateLines.push(`// Entity Context: ${entityDisplay}`);
      templateLines.push('// All template rows will target this entity. Update this header if you change entities.');
      templateLines.push('// Smart injection will automatically use this entity for Attributes, Labels, and DataTags.');
      templateLines.push('// ----------------------------------------------------------------');
    }

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
        const extractedValue = token.name === entityToken?.name
          ? (selectedEntity || extractedValues.get(token.name))
          : extractedValues.get(token.name);
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
          return extractedValues.has(token.name) ? extractedValues.get(token.name) : '';
        });
        templateLines.push(headerValues.join(','));
      }
    }

    // Add pre-filled data line for table tokens if any were extracted
    if (tableTokens.length > 0) {
      const hasExtractedTableValues = tableTokens.some(token => {
        if (entityToken && token.name === entityToken.name) {
          return Boolean(selectedEntity);
        }
        return extractedValues.has(token.name);
      });
      if (hasExtractedTableValues) {
        const tableValues = tableTokens.map(token => {
          if (entityToken && token.name === entityToken.name) {
            return selectedEntity || '';
          }
          return extractedValues.has(token.name) ? extractedValues.get(token.name) : '';
        });
        templateLines.push(tableValues.join(','));
      }
    }

    const templateText = templateLines.join('\n');

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
    if (xmlContextUri && sourceXmlDocument) {
      rememberSourceXmlMapping(newDocument.uri, xmlContextUri);

      // Also store token values that affect injection
      const affectingTokens = new Map<string, string>();
      for (const tokenDef of tokenDefinitions) {
        if (tokenDef.tokenReadPaths) {
          for (const [tokenName, readPath] of Object.entries(tokenDef.tokenReadPaths)) {
            if (readPath.affectsInjection && extractedValues.has(tokenName)) {
              affectingTokens.set(tokenName, extractedValues.get(tokenName)!);
            }
          }
        }
      }
      if (entityToken && selectedEntity) {
        affectingTokens.set(entityToken.name, selectedEntity);
      }
      if (affectingTokens.size > 0) {
        injectionAffectingTokens.set(newDocument.uri.toString(), affectingTokens);
      }
    }

    if (entityToken && selectedEntity) {
      rememberEntitySelectionForDocument(newDocument, selectedEntity);
    }

    markDocumentAsTemplate(newDocument, documentType);
    void updateDocumentTypeContext(newDocument);

    vscode.window.showInformationMessage(`Kahua: Token template opened in new editor for ${fragmentIds.join(', ')}`);
    setGenerationStatus('Template ready in new editor', true);

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    vscode.window.showErrorMessage(`Kahua Token Template: ${message}`);
    setGenerationStatus('Generation failed', true);
  }
}

/**
 * Generates from a template or snippet document using the existing logic
 */
async function generateFromTemplateOrSnippet(target: OutputTarget): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    throw new Error('No active editor found.');
  }

  const document = editor.document;
  if (!isTemplateDocument(document) && !isSnippetDocument(document)) {
    throw new Error('This command is only available when editing a template or snippet.');
  }

  // Get the fragment IDs that this template/snippet was generated for
  // We'll need to infer this from the document or use a default approach
  const fragmentIds = inferFragmentIdsFromDocument(document);
  if (fragmentIds.length === 0) {
    throw new Error('Could not determine which fragments this template/snippet uses.');
  }

  // Use the existing handleSelection logic but with our specific target
  const generationResult = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Generating XML fragments...",
    cancellable: false
  }, async (progress) => {
    return await handleSelectionInternal(fragmentIds, editor, progress);
  });

  if (!generationResult) {
    return;
  }

  await finalizeGeneratedFragmentsWithTarget(editor, fragmentIds, generationResult, target);
}

/**
 * Generates from template/snippet at cursor in any document
 */
async function generateFromTemplateOrSnippetAtCursor(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    throw new Error('No active editor found.');
  }

  // Check if current document is a template/snippet
  if (isTemplateDocument(editor.document) || isSnippetDocument(editor.document)) {
    // Generate from current template/snippet at cursor
    await generateFromTemplateOrSnippet({ type: 'currentFile', uri: editor.document.uri, insertionStrategy: 'cursor' });
    return;
  }

  // Check if we have any open template/snippet documents
  const openTemplateOrSnippet = vscode.workspace.textDocuments.find(doc => 
    isTemplateDocument(doc) || isSnippetDocument(doc)
  );

  if (!openTemplateOrSnippet) {
    vscode.window.showErrorMessage('No template or snippet document is currently open.');
    return;
  }

  // If multiple template/snippet documents are open, let user select
  const allTemplatesAndSnippets = vscode.workspace.textDocuments.filter(doc => 
    isTemplateDocument(doc) || isSnippetDocument(doc)
  );

  let selectedDocument = openTemplateOrSnippet;
  if (allTemplatesAndSnippets.length > 1) {
    const items = allTemplatesAndSnippets.map(doc => ({
      label: `${isTemplateDocument(doc) ? 'Template' : 'Snippet'}: ${doc.fileName}`,
      description: getWorkspaceRelativePath(doc.uri),
      document: doc
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select template or snippet to generate from',
      title: 'Kahua: Select Source'
    });

    if (!selected) {
      return;
    }

    selectedDocument = selected.document;
  }

  // Generate from selected template/snippet into current document at cursor
  const fragmentIds = inferFragmentIdsFromDocument(selectedDocument);
  if (fragmentIds.length === 0) {
    throw new Error('Could not determine which fragments the selected template/snippet uses.');
  }

  const tempEditor = await vscode.window.showTextDocument(selectedDocument, { preview: true, preserveFocus: true });
  
  const generationResult = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Generating XML fragments...",
    cancellable: false
  }, async (progress) => {
    return await handleSelectionInternal(fragmentIds, tempEditor, progress);
  });

  if (!generationResult) {
    return;
  }

  await finalizeGeneratedFragmentsWithTarget(tempEditor, fragmentIds, generationResult, { 
    type: 'currentFile', 
    uri: editor.document.uri, 
    insertionStrategy: 'cursor' 
  });

  // Switch back to original editor
  await vscode.window.showTextDocument(editor.document);
}

/**
 * Infers fragment IDs from a template or snippet document by looking at the header comment
 */
function inferFragmentIdsFromDocument(document: vscode.TextDocument): string[] {
  for (let i = 0; i < Math.min(10, document.lineCount); i++) {
    const text = document.lineAt(i).text.trim();
    if (!text.startsWith('//')) {
      continue;
    }

    // Look for patterns like "// Kahua Template for attributes" or "// Kahua Snippet for lookups"
    const match = text.match(/^\/\/\s*(?:kahua\s+)?(?:template|snippet)\s+for\s+(.+)$/i);
    if (match) {
      const fragmentsText = match[1].split(/[,&]/)[0].trim();
      // For now, return as single fragment - could be enhanced to parse multiple
      return [fragmentsText.toLowerCase()];
    }
  }

  // Default fallback - could be enhanced to analyze document type and provide defaults
  return [];
}

/**
 * Finalizes generated fragments with a specific target (variation of existing logic)
 */
async function finalizeGeneratedFragmentsWithTarget(
  editor: vscode.TextEditor,
  fragmentIds: string[],
  generation: GeneratedFragmentResult,
  target: OutputTarget
): Promise<void> {
  const currentDocument = editor.document;
  const currentFileUri = currentDocument.uri;
  const affectingTokens = injectionAffectingTokens.get(currentFileUri.toString());

  switch (target.type) {
    case 'currentFile': {
      const currentFileResults = await insertXmlIntoFile(
        target.uri,
        generation.generatedXml,
        target.insertionStrategy,
        generation.fragmentDefinition,
        affectingTokens,
        generation.tokenDefinitions
      );
      await openInjectionReport(currentFileResults, target.uri, generation.generatedXml);
      vscode.window.showInformationMessage(
        `Kahua: Generated fragments for ${fragmentIds.join(', ')} inserted into current file`
      );
      setGenerationStatus('Inserted fragments into current file', true);
      break;
    }

    case 'sourceFile': {
      const sourceFileResults = await insertXmlIntoFile(
        target.uri,
        generation.generatedXml,
        'smart',
        generation.fragmentDefinition,
        affectingTokens,
        generation.tokenDefinitions
      );
      const sourceFileName = getWorkspaceRelativePath(target.uri);
      await openInjectionReport(sourceFileResults, target.uri, generation.generatedXml);
      vscode.window.showInformationMessage(
        `Kahua: Generated fragments for ${fragmentIds.join(', ')} inserted into source file ${sourceFileName}`
      );
      setGenerationStatus(`Inserted fragments into ${sourceFileName}`, true);
      break;
    }

    case 'selectFile': {
      const selectFileResults = await insertXmlIntoFile(
        target.uri,
        generation.generatedXml,
        target.insertionStrategy ?? 'smart',
        generation.fragmentDefinition,
        affectingTokens,
        generation.tokenDefinitions
      );
      const fileName = getWorkspaceRelativePath(target.uri);
      await openInjectionReport(selectFileResults, target.uri, generation.generatedXml);
      vscode.window.showInformationMessage(
        `Kahua: Generated fragments for ${fragmentIds.join(', ')} inserted into ${fileName}`
      );
      setGenerationStatus(`Inserted fragments into ${fileName}`, true);
      break;
    }

    case 'newEditor': {
      const newDocument = await vscode.workspace.openTextDocument({
        content: generation.generatedXml,
        language: 'xml'
      });
      await vscode.window.showTextDocument(newDocument, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false
      });
      vscode.window.showInformationMessage(
        `Kahua: Generated fragments for ${fragmentIds.join(', ')} opened in new editor`
      );
      setGenerationStatus('Opened fragments in new editor', true);
      break;
    }

    case 'clipboard': {
      await vscode.env.clipboard.writeText(generation.generatedXml);
      vscode.window.showInformationMessage(
        `Kahua: Generated fragments for ${fragmentIds.join(', ')} copied to clipboard`
      );
      setGenerationStatus('Fragments copied to clipboard', true);
      break;
    }
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

  const generationResult = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Generating XML fragments...",
    cancellable: false
  }, async (progress) => {
    const result = await handleSelectionInternal(fragmentIds, editor, progress);
    return result;
  });

  if (!generationResult) {
    return;
  }

  await finalizeGeneratedFragments(editor, fragmentIds, generationResult);
}

/**
 * Internal implementation of selection handling with progress reporting
 */
function getTokenValues(
    headerTokens: ParsedToken[],
    tableTokens: ParsedToken[],
    headerLine: string | undefined,
    dataLine: string
): { cleanTokenValues: Record<string, string>, rawTokenValues: Record<string, string> } {
    const rawTokenValues: Record<string, string> = {};
    const cleanTokenValues: Record<string, string> = {};

    if (headerLine) {
        const headerParts = headerLine.split(',');
        for (let i = 0; i < headerTokens.length; i++) {
            const token = headerTokens[i];
            const rawPart = headerParts[i] || '';
            const trimmedPart = rawPart.trim();
            rawTokenValues[token.name] = rawPart || token.defaultValue;
            cleanTokenValues[token.name] = toPascalCase(trimmedPart || token.defaultValue);
        }
    }

    const dataParts = dataLine.split(',');
    for (let i = 0; i < tableTokens.length; i++) {
        const token = tableTokens[i];
        const rawPart = dataParts[i] || '';
        const trimmedPart = rawPart.trim();
        rawTokenValues[token.name] = rawPart || token.defaultValue;
        cleanTokenValues[token.name] = toPascalCase(trimmedPart || token.defaultValue);
    }

    return { cleanTokenValues, rawTokenValues };
}

async function handleSelectionInternal(
    fragmentIds: string[],
    editor: vscode.TextEditor,
    progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<GeneratedFragmentResult | undefined> {
    try {
        progress.report({ message: "Loading configuration...", increment: 10 });
        
        // Check if we're operating on a template/snippet document
        const isTemplate = isTemplateDocument(editor.document);
        const isSnippet = isSnippetDocument(editor.document);
        const isTemplateOrSnippet = isTemplate || isSnippet;
        
        // If we're in a template/snippet, we need to get the source XML document for token reading
        let sourceXmlDocumentForTokens: vscode.TextDocument | undefined;
        if (isTemplateOrSnippet) {
            sourceXmlDocumentForTokens = await getXmlDocumentForContext(editor.document);
            debugLog(`[DEBUG] handleSelectionInternal: Using source XML for token reading: ${sourceXmlDocumentForTokens?.uri.fsPath}`);
        }
        
        const documentType = requireDocumentType(editor.document);
        let documentText: string;
        try {
            documentText = editor.document.getText();
        } catch (readError) {
            throw new Error('Unable to read the current editor content. Please save or reopen the document and try again.');
        }

        if (!documentText || documentText.trim() === '') {
            throw new Error('Current document is empty. Fill the template with token values before running the generator.');
        }

        const config = getKahuaConfig(currentResource());
        const xmlIndentSize = config.get<number>('xmlIndentSize') || 2;
        const applyFormatting = config.get<boolean>('formatXmlOutput') === true;
        const suppressWarnings = config.get<boolean>('suppressInvalidConditionWarnings') || false;

        const tokenDefinitions = config.get<TokenNameDefinition[]>('tokenNameDefinitions') || [];
        const fragmentDefinitions = config.get<FragmentDefinition[]>('fragmentDefinitions') || [];

        if (tokenDefinitions.length === 0) {
            throw new Error('No token name definitions found. Please configure kahua.tokenNameDefinitions in your settings.');
        }

        if (fragmentDefinitions.length === 0) {
            throw new Error('No fragment definitions found. Please configure kahua.fragmentDefinitions in your settings.');
        }

        progress.report({ message: "Validating fragments...", increment: 20 });

        const unknown = fragmentIds.filter(id => !fragmentDefinitions.some(d => d.id === id));
        if (unknown.length) {
            throw new Error(`Menu references unknown fragment id(s): ${unknown.join(', ')}. Use FragmentDefinition.id (not 'name').`);
        }

        const selectedFragmentDefsRaw = fragmentDefinitions.filter(def => fragmentIds.includes(def.id));
        if (selectedFragmentDefsRaw.length === 0) {
            throw new Error(`No matching fragment definitions found for: ${fragmentIds.join(', ')}`);
        }
        const selectedFragmentDefs = enforceFragmentApplicability(selectedFragmentDefsRaw, documentType);
        setGenerationStatus('Validating template data…', false);

        const allTokenReferences = new Set<string>();
        selectedFragmentDefs.forEach(def => {
            def.tokenReferences.forEach(ref => allTokenReferences.add(ref));
        });

        const { headerTokens, tableTokens, tokenDefaults } = mergeTokenDefinitions(
            tokenDefinitions,
            Array.from(allTokenReferences)
        );

        const groups = splitIntoGroups(documentText);
        if (groups.length === 0) {
            throw new Error('Current document contains no valid token data. Remove comments/whitespace-only lines or add token rows.');
        }

        setGenerationStatus(`Detected ${groups.length} group${groups.length === 1 ? '' : 's'} - preparing…`, false);
        const allWarnings: string[] = [];
        const outputSections: string[] = [];

        for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
            const group = groups[groupIndex];
            setGenerationStatus(`Processing group ${groupIndex + 1} of ${groups.length}…`, false);
            const headerLine = headerTokens.length > 0 && group.length > 0 ? group[0] : undefined;
            const dataLines = headerLine ? group.slice(1) : group;

            if (tableTokens.length > 0 && dataLines.length === 0) {
                throw new Error(`Group ${groupIndex + 1}: No data lines found. Header tokens were processed but no table data rows remain.`);
            }

            const groupTokenData: Array<{ clean: Record<string, string>; raw: Record<string, string> }> = [];
            const tableSectionOutputs = new Map<string, { label: string; header?: string; body?: string; footer?: string }>();
            const groupedSectionOutputs = new Map<string, { label: string; body?: string }>();

            progress.report({ message: `Processing group ${groupIndex + 1} rows...`, increment: 30 });
            const groupRenderStart = Date.now();

            const precomputedFragments = new Map<string, {
                processedFragmentSets: Record<string, Record<string, string>>;
                conditionalFragmentSets: Record<string, ConditionalFragmentEntry[]>;
            }>();

            for (const fragmentDef of selectedFragmentDefs) {
                const { processedFragmentSets, conditionalFragmentSets } = processFragmentTemplates(
                    fragmentDef.fragments,
                    {},
                    {},
                    suppressWarnings
                );
                precomputedFragments.set(fragmentDef.id, { processedFragmentSets, conditionalFragmentSets });
            }

            const BATCH_SIZE = 50;
            const totalRows = dataLines.length;

            for (let batchStart = 0; batchStart < totalRows; batchStart += BATCH_SIZE) {
                const batchEnd = Math.min(batchStart + BATCH_SIZE, totalRows);
                const batch = dataLines.slice(batchStart, batchEnd);

                const batchProgress = Math.floor((batchEnd / totalRows) * 40);
                progress.report({
                    message: `Processing rows ${batchStart + 1}-${batchEnd} of ${totalRows}...`,
                    increment: batchProgress / Math.ceil(totalRows / BATCH_SIZE)
                });

                for (let lineIndex = 0; lineIndex < batch.length; lineIndex++) {
                    const line = batch[lineIndex];
                    const { cleanTokenValues, rawTokenValues } = getTokenValues(headerTokens, tableTokens, headerLine, line);

                    groupTokenData.push({ clean: { ...cleanTokenValues }, raw: { ...rawTokenValues } });

                    for (const fragmentDef of selectedFragmentDefs) {
                        const precomputed = precomputedFragments.get(fragmentDef.id)!;
                        const warnings: string[] = [];

                        const processedFragmentSets: Record<string, Record<string, string>> = {};

                        for (const [setName, fragments] of Object.entries(precomputed.processedFragmentSets)) {
                            processedFragmentSets[setName] = { ...fragments };
                        }

                        for (const [setName, conditionalFragments] of Object.entries(precomputed.conditionalFragmentSets)) {
                            if (!processedFragmentSets[setName]) {
                                processedFragmentSets[setName] = {};
                            }
                            for (const entry of conditionalFragments) {
                                const { result: keyResult, warnings: keyWarnings } = renderCompiledTemplate(
                                    entry.compiledKey,
                                    cleanTokenValues,
                                    rawTokenValues,
                                    suppressWarnings
                                );
                                warnings.push(...keyWarnings);
                                const normalizedKey = keyResult.trim();
                                if (normalizedKey) {
                                    debugLog(`[KAHUA] Row evaluation: ${setName}.${entry.rawKey} -> "${normalizedKey}"`);
                                    processedFragmentSets[setName][normalizedKey] = entry.template;
                                }
                            }
                        }

                        const fragmentType = fragmentDef.type || 'grouped';
                        const fragmentLabel = fragmentDef.name;

                        if (fragmentType === 'table') {
                            for (const [setName, fragments] of Object.entries(processedFragmentSets)) {
                                const groupKey = setName === 'default' ? 'default' : setName;
                                const sectionId = `${fragmentLabel}||${groupKey}`;
                                if (!tableSectionOutputs.has(sectionId)) {
                                    const label = groupKey === 'default' ? fragmentLabel : `${fragmentLabel} - ${groupKey}`;
                                    tableSectionOutputs.set(sectionId, { label });
                                }
                                const section = tableSectionOutputs.get(sectionId)!;

                                const headerTemplate = fragments.header;
                                if (headerTemplate && !section.header) {
                                    const rendered = renderTemplate(headerTemplate, cleanTokenValues, rawTokenValues, suppressWarnings);
                                    section.header = rendered.result;
                                    allWarnings.push(...rendered.warnings);
                                }

                                const bodyTemplate = fragments.body;
                                if (bodyTemplate) {
                                    const rendered = renderTemplate(bodyTemplate, cleanTokenValues, rawTokenValues, suppressWarnings);
                                    section.body = section.body ? `${section.body}\n${rendered.result}` : rendered.result;
                                    allWarnings.push(...rendered.warnings);
                                }

                                const footerTemplate = fragments.footer;
                                if (footerTemplate && !section.footer) {
                                    const rendered = renderTemplate(footerTemplate, cleanTokenValues, rawTokenValues, suppressWarnings);
                                    section.footer = rendered.result;
                                    allWarnings.push(...rendered.warnings);
                                }
                            }
                        } else {
                            for (const [setName, fragments] of Object.entries(processedFragmentSets)) {
                                for (const [key, template] of Object.entries(fragments)) {
                                    const fragmentKeyName = setName === 'default' ? key : `${setName}.${key}`;
                                    const sectionId = `${fragmentLabel}||${fragmentKeyName}`;
                                    if (!groupedSectionOutputs.has(sectionId)) {
                                        groupedSectionOutputs.set(sectionId, { label: fragmentKeyName });
                                    }
                                    const section = groupedSectionOutputs.get(sectionId)!;
                                    const rendered = renderTemplate(template, cleanTokenValues, rawTokenValues, suppressWarnings);
                                    section.body = section.body ? `${section.body}\n${rendered.result}` : rendered.result;
                                    allWarnings.push(...rendered.warnings);
                                }
                            }
                        }
                    }
                }

                if (batchEnd < totalRows) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }
            logDuration(`Group ${groupIndex + 1}: fragment rendering`, groupRenderStart);

            const allTokenNames = [...headerTokens.map(t => t.name), ...tableTokens.map(t => t.name)];
            debugLog(`[KAHUA] Formatting group ${groupIndex + 1}: preparing token table for ${groupTokenData.length} rows`);
            const tokenTableStart = Date.now();
            const tokenTable = createFormattedTokenTable(allTokenNames, groupTokenData, tokenDefaults, groupIndex + 1);
            logDuration(`Group ${groupIndex + 1}: token table`, tokenTableStart);

            const groupOutputSections: string[] = [tokenTable];
            const tableFormattingStart = Date.now();
            debugLog(`[KAHUA] Formatting group ${groupIndex + 1}: emitting table fragments (${tableSectionOutputs.size})`);
            for (const section of tableSectionOutputs.values()) {
                const parts: string[] = [];
                if (section.header) parts.push(section.header);
                if (section.body) parts.push(section.body);
                if (section.footer) parts.push(section.footer);
                if (parts.length === 0) {
                    continue;
                }
                let body = parts.join('\n');
                if (applyFormatting) {
                    debugLog(`[KAHUA] Formatting group ${groupIndex + 1}: applying XML formatting to table section "${section.label}"`);
                    body = formatXml(body, xmlIndentSize);
                }
                groupOutputSections.push(`\n <!-- ${section.label} -->\n\n${body}`);
            }
            logDuration(`Group ${groupIndex + 1}: table fragment assembly`, tableFormattingStart);

            const groupedFormattingStart = Date.now();
            debugLog(`[KAHUA] Formatting group ${groupIndex + 1}: emitting grouped fragments (${groupedSectionOutputs.size})`);
            for (const section of groupedSectionOutputs.values()) {
                if (!section.body) {
                    continue;
                }
                let body = section.body;
                if (applyFormatting) {
                    debugLog(`[KAHUA] Formatting group ${groupIndex + 1}: applying XML formatting to grouped section "${section.label}"`);
                    body = formatXml(body, xmlIndentSize);
                }
                groupOutputSections.push(`\n <!-- ${section.label} -->\n\n${body}`);
            }
            logDuration(`Group ${groupIndex + 1}: grouped fragment assembly`, groupedFormattingStart);

            outputSections.push(groupOutputSections.join('\n\n'));
        }

        setGenerationStatus('Formatting generated XML…', false);
        if (allWarnings.length > 0 && !suppressWarnings) {
            vscode.window.showWarningMessage(`Kahua: ${allWarnings.join('; ')}`);
        }

        let generatedXml = outputSections.join('\n\n');

        if (applyFormatting) {
            generatedXml = formatXml(generatedXml, xmlIndentSize);
        }

        return {
            generatedXml,
            fragmentDefinition: selectedFragmentDefs[0],
            tokenDefinitions
        };

    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error occurred';
        vscode.window.showErrorMessage(`Kahua Attribute Generator: ${message}`);
        setGenerationStatus('Generation failed', true);
        return undefined;
    }
}

async function finalizeGeneratedFragments(
  editor: vscode.TextEditor,
  fragmentIds: string[],
  generation: GeneratedFragmentResult
): Promise<void> {
  const currentDocument = editor.document;
  const currentFileUri = currentDocument.uri;
  const rememberedSourceUri = getRememberedSourceXmlUri(currentDocument);

  const target: OutputTarget | undefined = rememberedSourceUri
    ? { type: 'sourceFile', uri: rememberedSourceUri }
    : await showOutputTargetQuickPick(currentDocument);

  if (!target) {
    vscode.window.showInformationMessage('Kahua: Generation cancelled');
    setGenerationStatus('Generation cancelled', true);
    return;
  }

  const affectingTokens = injectionAffectingTokens.get(currentFileUri.toString());

  switch (target.type) {
    case 'currentFile': {
      const currentFileResults = await insertXmlIntoFile(
        target.uri,
        generation.generatedXml,
        target.insertionStrategy,
        generation.fragmentDefinition,
        affectingTokens,
        generation.tokenDefinitions
      );
      await openInjectionReport(currentFileResults, target.uri, generation.generatedXml);
      vscode.window.showInformationMessage(
        `Kahua: Generated fragments for ${fragmentIds.join(', ')} inserted into current file`
      );
      setGenerationStatus('Inserted fragments into current file', true);
      break;
    }

    case 'sourceFile': {
      const sourceFileResults = await insertXmlIntoFile(
        target.uri,
        generation.generatedXml,
        'smart',
        generation.fragmentDefinition,
        affectingTokens,
        generation.tokenDefinitions
      );
      const sourceFileName = getWorkspaceRelativePath(target.uri);
      await openInjectionReport(sourceFileResults, target.uri, generation.generatedXml);
      vscode.window.showInformationMessage(
        `Kahua: Generated fragments for ${fragmentIds.join(', ')} inserted into source file ${sourceFileName}`
      );
      setGenerationStatus(`Inserted fragments into ${sourceFileName}`, true);
      break;
    }

    case 'selectFile': {
      const selectFileResults = await insertXmlIntoFile(
        target.uri,
        generation.generatedXml,
        target.insertionStrategy ?? 'smart',
        generation.fragmentDefinition,
        affectingTokens,
        generation.tokenDefinitions
      );
      const fileName = getWorkspaceRelativePath(target.uri);
      await openInjectionReport(selectFileResults, target.uri, generation.generatedXml);
      vscode.window.showInformationMessage(
        `Kahua: Generated fragments for ${fragmentIds.join(', ')} inserted into ${fileName}`
      );
      setGenerationStatus(`Inserted fragments into ${fileName}`, true);
      break;
    }

    case 'newEditor': {
      const newDocument = await vscode.workspace.openTextDocument({
        content: generation.generatedXml,
        language: 'xml'
      });
      await vscode.window.showTextDocument(newDocument, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false
      });
      vscode.window.showInformationMessage(
        `Kahua: Generated fragments for ${fragmentIds.join(', ')} opened in new editor`
      );
      setGenerationStatus('Opened fragments in new editor', true);
      break;
    }

    case 'clipboard': {
      await vscode.env.clipboard.writeText(generation.generatedXml);
      vscode.window.showInformationMessage(
        `Kahua: Generated fragments for ${fragmentIds.join(', ')} copied to clipboard`
      );
      setGenerationStatus('Fragments copied to clipboard', true);
      break;
    }
  }
}

