import * as vscode from 'vscode';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
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
  | { type: 'currentFile'; uri: vscode.Uri }
  | { type: 'sourceFile'; uri: vscode.Uri }  // Associated XML file from snippet/template generation
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
  parsed: any;
  contentHash: string;
  timestamp: number;
}

const xmlParseCache = new Map<string, XmlCacheEntry>();
const XML_CACHE_MAX_SIZE = 50;
const XML_CACHE_MAX_AGE = 5 * 60 * 1000; // 5 minutes

const DOCUMENT_TYPE_CONTEXT_KEY = 'kahua.documentType';
const DOCUMENT_APPLICABLE_CONTEXT_KEY = 'kahua.hasApplicableDocument';
const TEMPLATE_DOCUMENT_CONTEXT_KEY = 'kahua.isTemplateDocument';
const SNIPPET_DOCUMENT_CONTEXT_KEY = 'kahua.isSnippetDocument';
const SELECTION_CONTEXT_KEY = 'kahua.hasValidSelection';
const CAN_GENERATE_TEMPLATES_CONTEXT_KEY = 'kahua.canGenerateTemplates';
const CAN_GENERATE_SNIPPETS_CONTEXT_KEY = 'kahua.canGenerateSnippets';
const TEMPLATE_KIND_CONTEXT_KEY = 'kahua.templateKind';
const SNIPPET_KIND_CONTEXT_KEY = 'kahua.snippetKind';

// Performance: Conditional debugging
const DEBUG_MODE = process.env.NODE_ENV === 'development';
const debugLog = DEBUG_MODE ? console.log : () => {};
const debugWarn = DEBUG_MODE ? console.warn : () => {};
const debugError = DEBUG_MODE ? console.error : () => {};

let generateStatusBarItem: vscode.StatusBarItem | undefined;

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

function parseXmlForDocumentTypeDetection(text: string): any | undefined {
  try {
    // Performance: Check cache first
    const contentHash = simpleHash(text);
    const cacheKey = `doctype_${contentHash}`;
    const cached = xmlParseCache.get(cacheKey);
    
    if (cached && cached.contentHash === contentHash) {
      cached.timestamp = Date.now(); // Update access time
      return cached.parsed;
    }

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text',
      ignoreDeclaration: true,
      preserveOrder: false,
      allowBooleanAttributes: true
    });

    const cleanedText = text.replace(/xmlns="[^"]*"/g, '');
    const parsed = parser.parse(cleanedText);
    
    // Performance: Cache the result
    cleanupXmlCache();
    xmlParseCache.set(cacheKey, {
      parsed,
      contentHash,
      timestamp: Date.now()
    });
    
    return parsed;
  } catch (error) {
    debugWarn('[KAHUA] Failed to parse XML for document type detection:', error);
    return undefined;
  }
}

function resolveRootElementName(parsedXml: any): string | undefined {
  if (!parsedXml || typeof parsedXml !== 'object') {
    return undefined;
  }

  const rootKeys = Object.keys(parsedXml);
  for (const key of rootKeys) {
    if (!key) continue;
    if (key.startsWith('?') || key.startsWith('@') || key.startsWith('#')) {
      continue;
    }
    return key;
  }

  return undefined;
}

function hasXmlPath(source: any, xpath: string): boolean {
  if (!source || !xpath) {
    return false;
  }

  const parts = xpath
    .split('/')
    .map(part => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return false;
  }

  let currentLevel: any[] = [source];

  for (const part of parts) {
    const nextLevel: any[] = [];

    for (const candidate of currentLevel) {
      if (candidate == null) {
        continue;
      }

      const nodes = Array.isArray(candidate) ? candidate : [candidate];
      for (const node of nodes) {
        if (node != null && typeof node === 'object' && part in node) {
          const value = node[part];
          if (Array.isArray(value)) {
            nextLevel.push(...value);
          } else if (value != null) {
            nextLevel.push(value);
          }
        }
      }
    }

    if (nextLevel.length === 0) {
      return false;
    }

    currentLevel = nextLevel;
  }

  return currentLevel.length > 0;
}

function evaluateDocumentTypeRule(
  rule: DocumentTypeRule,
  parsedXml: any,
  rootElementName?: string
): boolean {
  switch (rule.kind) {
    case 'rootElement':
      if (!rule.value || !rootElementName) {
        return false;
      }
      return rootElementName.toLowerCase() === rule.value.toLowerCase();
    case 'xpathExists':
      return !!(rule.xpath && hasXmlPath(parsedXml, rule.xpath));
    case 'xpathNotExists':
      return !!(rule.xpath) && !hasXmlPath(parsedXml, rule.xpath);
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
    console.log('[KAHUA] updateDocumentTypeContext: No active document');
    await setDocumentTypeContext(undefined);
    await setTemplateDocumentContext(undefined);
    await setSnippetDocumentContext(undefined);
    await setSelectionContext(undefined);
    await updateGenerationAvailability(undefined);
    return;
  }

  await setSnippetDocumentContext(document);
  await setTemplateDocumentContext(document);
  if (document === vscode.window.activeTextEditor?.document) {
    await setSelectionContext(vscode.window.activeTextEditor);
  }
  await updateGenerationAvailability(document);

  const override = documentTypeOverrides.get(document.uri.toString());
  if (override) {
    console.log(`[KAHUA] updateDocumentTypeContext: Using override ${override} for ${document.uri.fsPath}`);
    await setDocumentTypeContext(override);
    return;
  }

  if (document.languageId !== 'xml') {
    console.log(`[KAHUA] updateDocumentTypeContext: Document ${document.uri.fsPath} is not XML`);
    await setDocumentTypeContext(undefined);
    return;
  }

  const typeId = getOrDetectDocumentType(document);
  console.log(`[KAHUA] updateDocumentTypeContext: Detected type ${typeId} for ${document.uri.fsPath}`);
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
    const showButton =
      isTemplate &&
      getKahuaConfig(document?.uri).get<boolean>('showSimplifiedWorkflow') !== false;
    if (showButton) {
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

function rememberSourceXmlMapping(documentUri: vscode.Uri, sourceUri: vscode.Uri): void {
  sourceXmlFileMap.set(documentUri.toString(), sourceUri);
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
  debugLog(`[KAHUA] insertXmlIntoFile: target=${uri.fsPath} strategy=${strategy ?? 'prompt'}`);
  const editor = await vscode.window.showTextDocument(document, {
    preserveFocus: false,
    preview: false
  });

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
                console.log(`[DEBUG] Applied injection path template to "${sectionName}": ${modifiedXPath} (token: ${tokenName}=${tokenValue})`);
              } else {
                console.log(`[DEBUG] Skipping injection path template for "${sectionName}" - path "${xpath}" doesn't match template pattern`);
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
  const allTargetSections = parseTargetXmlStructure(document, injectionPaths);
  debugLog(`[KAHUA] insertXmlIntoFile: parseTargetXmlStructure completed in ${Date.now() - parseStart}ms with ${allTargetSections.length} sections`);

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
            insertPosition = document.lineAt(targetSection.closeTagLine).range.start;
            insertionText = '\n' + indentedContent + '\n';
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
 * Parses target XML file to find section tags where content can be inserted using configured injection paths
 * Creates multiple target sections when there are multiple matches for a path
 */
function parseTargetXmlStructure(document: vscode.TextDocument, injectionPaths: Record<string, string | InjectionPathConfig>): XmlTargetSection[] {
  const sections: XmlTargetSection[] = [];

  for (const [sectionName, pathConfig] of Object.entries(injectionPaths)) {
    // Normalize to always have path and displayAttribute(s)
    const xpath = typeof pathConfig === 'string' ? pathConfig : pathConfig.path;
    const displayAttrConfig = typeof pathConfig === 'string' ? 'Name' : (pathConfig.displayAttribute || 'Name');
    const displayAttributes = Array.isArray(displayAttrConfig) ? displayAttrConfig : [displayAttrConfig];

    const allTargets = findAllXPathTargets(document, xpath);

    // Deduplicate by line number
    const seenLines = new Set<number>();
    const uniqueTargets = allTargets.filter(target => {
      if (seenLines.has(target.line)) {
        return false;
      }
      seenLines.add(target.line);
      return true;
    });

    console.log(`[DEBUG] parseTargetXmlStructure: ${sectionName} -> ${uniqueTargets.length} unique targets (from ${allTargets.length} total)`);

    for (const target of uniqueTargets) {
      const line = document.lineAt(target.line);
      const text = line.text;

      // Use tag name from XML parser instead of regex
      const tagName = target.tagName;
      const indentation = text.match(/^(\s*)</)?.[1] || '';
      const isSelfClosing = text.includes('/>');

      // Try each display attribute in order until we find one with a value
      let context = `Line ${target.line + 1}`;
      let foundAttribute = false;
      for (const attr of displayAttributes) {
        const displayValue = target.attributes[attr];
        if (displayValue) {
          context += ` (${attr}="${displayValue}")`;
          foundAttribute = true;
          break;
        }
      }

      // If no configured attributes had values, try "Name" as a default fallback
      if (!foundAttribute && !displayAttributes.includes('Name')) {
        const nameValue = target.attributes['Name'];
        if (nameValue) {
          context += ` (Name="${nameValue}")`;
        }
      }
      
      let finalXpath = target.enrichedPath; // Use the pre-calculated enriched path

      if (isSelfClosing) {
        sections.push({
          tagName: sectionName,
          xmlNodeName: tagName,
          openTagLine: target.line,
          closeTagLine: target.line,
          indentation,
          isSelfClosing: true,
          lastChildLine: target.line, // For self-closing, lastChildLine is the same as openTagLine
          context,
          injectionPath: target.enrichedPath,
          attributes: target.attributes,
          nameAttributeValue: target.nameAttributeValue,
          enrichedPath: target.enrichedPath
        });
      } else {
        const closeTagLine = findClosingTag(document, tagName, target.line);
        const lastChildLine = findLastChildElement(document, target.line, closeTagLine);

        sections.push({
          tagName: sectionName,
          xmlNodeName: tagName,
          openTagLine: target.line,
          closeTagLine,
          indentation,
          isSelfClosing: false,
          lastChildLine: lastChildLine, // Use the locally calculated lastChildLine
          context,
          injectionPath: target.enrichedPath,
          attributes: target.attributes,
          nameAttributeValue: target.nameAttributeValue,
          enrichedPath: target.enrichedPath
        });
      }
    }
  }

  return sections;
}

/**
 * Performance: Get cached parsed XML document or parse and cache
 */
function getCachedParsedXml(document: vscode.TextDocument): any {
  const content = document.getText();
  const contentHash = simpleHash(content);
  const cacheKey = `${document.uri.toString()}_${contentHash}`;
  
  const cached = xmlParseCache.get(cacheKey);
  if (cached && cached.contentHash === contentHash) {
    cached.timestamp = Date.now(); // Update access time
    return cached.parsed;
  }
  
  // Parse and cache
  const parsed = parseXmlDocumentInternal(content);
  
  cleanupXmlCache();
  xmlParseCache.set(cacheKey, {
    parsed,
    contentHash,
    timestamp: Date.now()
  });
  
  return parsed;
}

/**
 * Internal XML parsing function (cached via getCachedParsedXml)
 */
function parseXmlDocumentInternal(xmlContent: string): any {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    ignoreDeclaration: true,
    preserveOrder: false,
    allowBooleanAttributes: true
  });

  const xmlText = xmlContent.replace(/xmlns="[^"]*"/g, '');
  const parsed = parser.parse(xmlText);

  // Debug: Log structure of parsed XML (only in development)
  if (process.env.NODE_ENV === 'development') {
    console.log('[DEBUG] ========== Parsed XML Structure ==========');
    console.log('[DEBUG] Root keys:', Object.keys(parsed));
    if (Object.keys(parsed).length > 0) {
      const rootKey = Object.keys(parsed)[0];
      const rootElement = parsed[rootKey];
      const childKeys = Object.keys(rootElement).filter(k => !k.startsWith('@_') && !k.startsWith('#'));
      console.log(`[DEBUG] Child keys under "${rootKey}":`, childKeys.slice(0, 20));
      if (childKeys.length > 20) {
        console.log(`[DEBUG] ... (${childKeys.length} total child keys)`);
      }
    }
  }

  return parsed;
}

/**
 * Parse XML document using fast-xml-parser (legacy function, use getCachedParsedXml)
 * @deprecated Use getCachedParsedXml for better performance
 */
function parseXmlDocument(document: vscode.TextDocument): any {
  return getCachedParsedXml(document);
}

/**
 * Traverse parsed XML object to find elements matching XPath
 * Returns elements with their identifying attributes
 */
function findElementsByXPath(parsedXml: any, xpath: string): XPathMatchedElement[] {
  let config = getKahuaConfig().get<ElementDisplayConfig>('elementDisplayAttributes');
  // Provide a fallback if configuration is not loaded correctly or missing properties
  if (!config) {
    config = {
      defaultOrder: ['Name', 'DisplayName', 'Id'],
      exclusions: ['App'],
      overrides: {
        Table: ['EntityDefName', 'Name'],
        ViewDef: ['DisplayName', 'Name']
      }
    };
  } else {
    // Ensure all required properties exist
    config.defaultOrder = config.defaultOrder || ['Name', 'DisplayName', 'Id'];
    config.exclusions = config.exclusions || ['App'];
    config.overrides = config.overrides || {
      Table: ['EntityDefName', 'Name'],
      ViewDef: ['DisplayName', 'Name']
    };
  }

  type TraversalResult = {
    element: any;
    nameAttributeValue?: string; // Generic property for the 'Name' attribute of any element
    currentEnrichedPath: string; // The XPath string accumulated so far with Name attributes
    pathNodes: Array<{ tagName: string; attributes: Record<string, any> }>;
  };
  
  let parts = xpath.split('/').filter(p => p);
  console.log(`[DEBUG] XPath parts:`, parts);

  let currentElements: TraversalResult[] = [];
  
  const rootKeys = Object.keys(parsedXml);
  if (rootKeys.length > 0) {
    const rootElement = parsedXml[rootKeys[0]];
    const rootTagName = rootKeys[0];
    const rootAttributes = Object.keys(rootElement).filter(k => k.startsWith('@_')).reduce((acc, key) => {
      acc[key.substring(2)] = rootElement[key];
      return acc;
    }, {} as Record<string, any>);
    
    const { displayName: rootNameAttr, isExcluded: rootIsExcluded } = getElementDisplayName(rootTagName, rootAttributes, config);

    const rootEnrichedPathSegment = rootIsExcluded || !rootNameAttr ? rootTagName : `${rootTagName} (${rootNameAttr})`;

    const rootPathNodes = [{ tagName: rootTagName, attributes: rootAttributes }];

    if (rootTagName === parts[0]) { // Use rootTagName instead of rootKeys[0] for consistency
      console.log(`[DEBUG] Root element ${rootKeys[0]} matches first part of xpath, starting from inside it`);
      currentElements = [{
        element: rootElement,
        nameAttributeValue: rootNameAttr,
        currentEnrichedPath: `/${rootEnrichedPathSegment}`,
        pathNodes: rootPathNodes.slice()
      }];
      parts = parts.slice(1);
      console.log(`[DEBUG] Remaining parts after skipping root:`, parts);
    } else {
      console.log(`[DEBUG] Root element is ${rootKeys[0]}, searching within it`);
      currentElements = [{
        element: rootElement,
        nameAttributeValue: rootNameAttr,
        currentEnrichedPath: `/${rootEnrichedPathSegment}`,
        pathNodes: rootPathNodes.slice()
      }];
    }
  } else {
    currentElements = [{ element: parsedXml, currentEnrichedPath: '', pathNodes: [] }];
  }

  console.log(`[DEBUG] Starting traversal with ${currentElements.length} element(s) and ${parts.length} part(s) to process`);
  
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    console.log(`[DEBUG] --- Processing part ${i+1}/${parts.length}: "${part}" ---`);
    
    const attrMatch = part.match(/^([\w.]+)\[@(\w+)='([^']+)'\]$/);
    const tagName = attrMatch ? attrMatch[1] : part;
    const filterAttrName = attrMatch ? attrMatch[2] : null;
    const filterAttrValue = attrMatch ? attrMatch[3] : null;

    console.log(`[DEBUG] Tag name: "${tagName}"${filterAttrName ? `, Filter: ${filterAttrName}='${filterAttrValue}'` : ''}`);

    const nextElements: TraversalResult[] = [];

    for (const current of currentElements) {
      const element = current.element;
      if (typeof element === 'object' && element !== null) {
        const availableKeys = Object.keys(element).filter(k => !k.startsWith('@_') && !k.startsWith('#'));
        console.log(`[DEBUG] Available keys in current element:`, availableKeys.slice(0, 10), availableKeys.length > 10 ? `... (${availableKeys.length} total)` : '');

        if (element[tagName]) {
          console.log(`[DEBUG] Found key "${tagName}" in element`);
          const candidates = Array.isArray(element[tagName]) ? element[tagName] : [element[tagName]];

          for (const candidate of candidates) {
            if (filterAttrName && filterAttrValue) {
              const attrKey = `@_${filterAttrName}`;
              if (candidate[attrKey] !== filterAttrValue) {
                continue;
              }
            }

            const attributesForCandidate = Object.keys(candidate).filter(k => k.startsWith('@_')).reduce((acc, key) => {
              acc[key.substring(2)] = candidate[key];
              return acc;
            }, {} as Record<string, any>);
            
            const { displayName, isExcluded } = getElementDisplayName(tagName, attributesForCandidate, config);
            const nameAttrValue = displayName; // Use the determined displayName
            
            const enrichedPathSegment = isExcluded || !nameAttrValue ? tagName : `${tagName} (${nameAttrValue})`;
            
            const nextPathNodes = [...current.pathNodes, { tagName, attributes: attributesForCandidate }];

            nextElements.push({
              element: candidate,
              nameAttributeValue: nameAttrValue,
              currentEnrichedPath: `${current.currentEnrichedPath}/${enrichedPathSegment}`,
              pathNodes: nextPathNodes
            });
          }
        } else {
          console.log(`[DEBUG] Key "${tagName}" NOT found in element`);
        }
      }
    }

    if (nextElements.length === 0) {
      console.log(`[DEBUG] ❌ No elements found for part: "${part}"`);
      console.log(`[DEBUG] Was searching for: "${tagName}" in ${currentElements.length} element(s)`);
      console.log(`[DEBUG] Full XPath that failed: ${xpath}`);
      return [];
    }

    currentElements = nextElements;
    console.log(`[DEBUG] ✅ Found ${currentElements.length} element(s) after processing "${part}"`);
  }

  const lastPart = parts[parts.length - 1];
  const tagName = lastPart.match(/^([\w.]+)/)?.[1] || lastPart;

  return currentElements.map(res => {
    const attributes: Record<string, any> = {};

    for (const key in res.element) {
      if (key.startsWith('@_')) {
        const attrName = key.substring(2);
        attributes[attrName] = res.element[key];
      }
    }

    return {
      tagName,
      attributes,
      nameAttributeValue: res.nameAttributeValue,
      enrichedPath: res.currentEnrichedPath,
      pathNodes: res.pathNodes
    };
  });
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

/**
 * Finds the line number corresponding to a matched XPath element by walking ancestor nodes
 */
function findLineNumberForPath(
  document: vscode.TextDocument,
  pathNodes: Array<{ tagName: string; attributes: Record<string, any> }>
): number {
  if (!pathNodes.length) {
    return -1;
  }

  let searchStart = 0;
  let searchEnd = document.lineCount - 1;

  for (let depth = 0; depth < pathNodes.length; depth++) {
    const node = pathNodes[depth];
    debugLog(`[KAHUA] Resolving XPath node ${depth + 1}/${pathNodes.length}: <${node.tagName}>`, node.attributes);
    const lineIndex = findLineForNodeInRange(document, node.tagName, node.attributes, searchStart, searchEnd);
    if (lineIndex === -1) {
      debugLog(`[KAHUA]   Not found between lines ${searchStart + 1}-${searchEnd + 1}`);
      return -1;
    }

    const lineText = document.lineAt(lineIndex).text;
    const isSelfClosing = lineText.includes('/>');
    const closeLine = isSelfClosing ? lineIndex : findClosingTag(document, node.tagName, lineIndex);

    if (depth === pathNodes.length - 1) {
      return lineIndex;
    }

    searchStart = lineIndex + 1;
    searchEnd = closeLine - 1;
    if (searchStart > searchEnd) {
      return -1;
    }
  }

  return -1;
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
 * Uses fast-xml-parser for accurate XML parsing
 * Returns array of objects with line numbers, tag names, and attributes
 */
function findAllXPathTargets(document: vscode.TextDocument, xpath: string): Array<{line: number, tagName: string, attributes: Record<string, any>, nameAttributeValue?: string, enrichedPath: string}> {
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

    const resolvedTargets: Array<{line: number; tagName: string; attributes: Record<string, any>; nameAttributeValue?: string; enrichedPath: string}> = [];

    for (const element of elements) {
      const line = findLineNumberForPath(document, element.pathNodes);
      if (line === -1) {
        console.warn(`[DEBUG] Unable to locate line for element ${element.tagName} at path ${element.enrichedPath}`);
        continue;
      }
      resolvedTargets.push({
        line,
        tagName: element.tagName,
        attributes: element.attributes,
        nameAttributeValue: element.nameAttributeValue,
        enrichedPath: element.enrichedPath
      });
    }

    console.log(`[DEBUG] Mapped to ${resolvedTargets.length} line numbers`);
    return resolvedTargets;
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
  return matches.length > 0 ? matches[0].line : -1;
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

        const storedSelection = getStoredTokenSelection(document, tokenName);
        if (storedSelection) {
          console.log(`[DEBUG] Using stored selection for ${tokenName}: ${storedSelection}`);
          value = storedSelection;
          break;
        }

        console.log(`[DEBUG] Extracting values for ${tokenName} from path: ${readPath.path}, attribute: ${readPath.attribute}`);
        const options = extractSelectableValues(document, readPath.path, readPath.attribute);
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
    if (target.xmlNodeName === 'HubDef' && target.nameAttributeValue) {
      label = `HubDef: ${target.nameAttributeValue} (${lineInfo})`;
    } else if (target.nameAttributeValue) {
      label = `${target.nameAttributeValue} (${lineInfo})`;
    }
    const description = target.context && target.context !== lineInfo ? target.context : undefined;

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
  console.log('[KAHUA] activate() called');
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
  generateStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  generateStatusBarItem.text = '$(rocket) Kahua Generate';
  generateStatusBarItem.command = 'kahua.generateEntities';
  generateStatusBarItem.tooltip = 'Kahua: Generate Entities';
  generateStatusBarItem.hide();
  context.subscriptions.push(generateStatusBarItem);
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

      if (event.affectsConfiguration('kahua.showSimplifiedWorkflow')) {
        void updateDocumentTypeContext(vscode.window.activeTextEditor?.document);
      }
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
    vscode.commands.registerCommand('kahua.generateIntoDocument', () => handleSimplifiedGeneration()),
    vscode.commands.registerCommand('kahua.selectEntityAndGenerate', () => handleEntitySelectionCommand()),
    vscode.commands.registerCommand('kahua.generateEntities', () => handleTemplateBasedGeneration()),
    vscode.commands.registerCommand('kahua.generateCustom', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('No active editor found.');
        return;
      }

      try {
        const documentType = requireDocumentType(editor.document);
        const pick = await selectCustomFragments('Select fragment type to generate', documentType);
        if (pick) {
          await handleSelection(pick.fragments);
        }
      } catch (error: unknown) {
        vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    }),
    vscode.commands.registerCommand('kahua.generateSnippetCustom', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('No active editor found.');
        return;
      }

      try {
        const documentType = requireDocumentType(editor.document);
        const pick = await selectCustomFragments('Select fragments for snippet generation', documentType);
        if (pick) {
          await generateSnippetForFragments(pick.fragments);
        }
      } catch (error: unknown) {
        vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    }),
    vscode.commands.registerCommand('kahua.generateTemplateCustom', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('No active editor found.');
        return;
      }

      try {
        const documentType = requireDocumentType(editor.document);
        const pick = await selectCustomFragments('Select fragments for template generation', documentType);
        if (pick) {
          await generateTemplateForFragments(pick.fragments);
        }
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
async function selectCustomFragments(
  placeholder: string,
  documentType: string
): Promise<{ label: string; fragments: string[] } | undefined> {
  const config = vscode.workspace.getConfiguration();
  const fragmentDefinitions = config.get<FragmentDefinition[]>('kahua.fragmentDefinitions') || [];

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
      title: 'Kahua Custom Fragment Selector'
    }
  );
}

async function handleSimplifiedGeneration(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('No active editor found.');
    return;
  }

  try {
    const templateMode = isTemplateDocument(editor.document);
    const snippetMode = isSnippetDocument(editor.document);
    const selectionMode = hasValidFragmentSelection(editor);
    if (!templateMode && !snippetMode && !selectionMode) {
      vscode.window.showErrorMessage('Select CSV rows or open a Kahua template/snippet before running this command.');
      return;
    }
    const documentType = requireDocumentType(editor.document);
    const defaultFragments = getDefaultFragmentsForDocumentType(documentType);

    if (defaultFragments.length === 0) {
      throw new Error(`No simplified fragments configured for document type "${documentType}".`);
    }

    await handleSelection(defaultFragments);
  } catch (error) {
    vscode.window.showErrorMessage(
      error instanceof Error ? error.message : `Kahua: ${error}`
    );
  }
}

async function handleEntitySelectionCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('No active editor found.');
    return;
  }

  try {
    if (!isTemplateDocument(editor.document)) {
      vscode.window.showErrorMessage('Entity selection is only available inside a Kahua template.');
      return;
    }
    const xmlDocument = await getXmlDocumentForContext(editor.document);
    if (!xmlDocument) {
      throw new Error('Entity selection requires an XML document or a generated template linked to an XML file.');
    }

    const entityOptions = extractSelectableValues(xmlDocument, 'EntityDefs/EntityDef', 'Name');
    if (entityOptions.length === 0) {
      throw new Error('No EntityDef entries were found in the current XML document.');
    }

    const selected = await showValueSelectionPick('entity', entityOptions);
    if (!selected) {
      vscode.window.showInformationMessage('Kahua: Entity selection cancelled.');
      return;
    }

    rememberEntitySelectionForUri(xmlDocument.uri, selected);
    rememberEntitySelectionForDocument(editor.document, selected);
    vscode.window.showInformationMessage(`Kahua: Entity "${selected}" selected.`);

    await handleSimplifiedGeneration();
  } catch (error) {
    vscode.window.showErrorMessage(
      error instanceof Error ? error.message : `Kahua: ${error}`
    );
  }
}

async function handleTemplateBasedGeneration(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('No active editor found.');
    return;
  }

  if (!isTemplateDocument(editor.document)) {
    vscode.window.showErrorMessage('Generate Entities is only available in Kahua template files.');
    return;
  }

  if (!getRememberedSourceXmlUri(editor.document)) {
    vscode.window.showErrorMessage('Kahua: Generate Entities is only available in templates created by the Kahua extension.');
    return;
  }

  await handleSimplifiedGeneration();
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
          debugLog(`[DEBUG] Calling readTokenValuesFromXml for ${tokenDef.id}`);
          const values = await readTokenValuesFromXml(sourceXmlDocument, tokenDef.tokenReadPaths);
          debugLog(`[DEBUG] Got ${values.size} values from readTokenValuesFromXml`);
          values.forEach((value, key) => extractedValues.set(key, value));
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

        const allWarnings: string[] = [];
        const outputSections: string[] = [];

        for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
            const group = groups[groupIndex];
            const headerLine = headerTokens.length > 0 && group.length > 0 ? group[0] : undefined;
            const dataLines = headerLine ? group.slice(1) : group;

            if (tableTokens.length > 0 && dataLines.length === 0) {
                throw new Error(`Group ${groupIndex + 1}: No data lines found. Header tokens were processed but no table data rows remain.`);
            }

            const groupTokenData: Array<{ clean: Record<string, string>; raw: Record<string, string> }> = [];
            const structuredFragments: {
                [fragmentName: string]: {
                    [group: string]: { header?: string; body: string[]; footer?: string }
                }
            } = {};

            const groupedFragments: { [fragmentName: string]: { [fragmentKey: string]: string[] } } = {};

            progress.report({ message: `Processing group ${groupIndex + 1} rows...`, increment: 30 });

            const precomputedFragments = new Map<string, {
                processedFragmentSets: Record<string, Record<string, string>>;
                conditionalFragmentSets: Record<string, Record<string, string>>;
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
                            for (const [conditionalKey, template] of Object.entries(conditionalFragments)) {
                                const strippedKey = conditionalKey.replace(/^"(.*)"$/, '$1');
                                let processedKey = strippedKey;

                                for (const [tokenName, cleanValue] of Object.entries(cleanTokenValues)) {
                                    const pattern = `{$${tokenName}`;
                                    if (processedKey.includes(pattern)) {
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
                                }

                                const { result, warnings: conditionalWarnings } = processConditionalTemplate(processedKey, cleanTokenValues, suppressWarnings);
                                warnings.push(...conditionalWarnings);

                                if (result.trim()) {
                                    debugLog(`[KAHUA] Row evaluation: ${setName}.${conditionalKey} -> "${result.trim()}"`);
                                    if (!processedFragmentSets[setName]) {
                                        processedFragmentSets[setName] = {};
                                    }
                                    processedFragmentSets[setName][result.trim()] = template;
                                }
                            }
                        }

                        const fragmentType = fragmentDef.type || 'grouped';
                        const setDisplayName = fragmentDef.name;

                        if (fragmentType === 'table') {
                            if (!structuredFragments[setDisplayName]) {
                                structuredFragments[setDisplayName] = { 'default': { body: [] } };
                            }
                            const groupKey = 'default';

                            const headerTemplate = processedFragmentSets[setDisplayName]?.header;
                            if (headerTemplate && !structuredFragments[setDisplayName][groupKey].header) {
                                const rendered = renderTemplate(headerTemplate, cleanTokenValues, rawTokenValues, suppressWarnings);
                                structuredFragments[setDisplayName][groupKey].header = rendered.result;
                                allWarnings.push(...rendered.warnings);
                            }

                            const bodyTemplate = processedFragmentSets[setDisplayName]?.body;
                            if (bodyTemplate) {
                                const rendered = renderTemplate(bodyTemplate, cleanTokenValues, rawTokenValues, suppressWarnings);
                                structuredFragments[setDisplayName][groupKey].body.push(rendered.result);
                                allWarnings.push(...rendered.warnings);
                            }

                            const footerTemplate = processedFragmentSets[setDisplayName]?.footer;
                            if (footerTemplate && !structuredFragments[setDisplayName][groupKey].footer) {
                                const rendered = renderTemplate(footerTemplate, cleanTokenValues, rawTokenValues, suppressWarnings);
                                structuredFragments[setDisplayName][groupKey].footer = rendered.result;
                                allWarnings.push(...rendered.warnings);
                            }
                        } else {
                            if (!groupedFragments[setDisplayName]) {
                                groupedFragments[setDisplayName] = {};
                            }
                            for (const [key, template] of Object.entries(processedFragmentSets[setDisplayName] || {})) {
                                if (!groupedFragments[setDisplayName][key]) {
                                    groupedFragments[setDisplayName][key] = [];
                                }
                                const rendered = renderTemplate(template, cleanTokenValues, rawTokenValues, suppressWarnings);
                                groupedFragments[setDisplayName][key].push(rendered.result);
                                allWarnings.push(...rendered.warnings);
                            }
                        }
                    }
                }

                if (batchEnd < totalRows) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }

            const allTokenNames = [...headerTokens.map(t => t.name), ...tableTokens.map(t => t.name)];
            const tokenTable = createFormattedTokenTable(allTokenNames, groupTokenData, tokenDefaults, groupIndex + 1);

            const groupOutputSections: string[] = [tokenTable];

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

  const target = rememberedSourceUri
    ? { type: 'sourceFile', uri: rememberedSourceUri }
    : await showOutputTargetQuickPick(currentDocument);

  if (!target) {
    vscode.window.showInformationMessage('Kahua: Generation cancelled');
    return;
  }

  const affectingTokens = injectionAffectingTokens.get(currentFileUri.toString());

  switch (target.type) {
    case 'currentFile': {
      const currentFileResults = await insertXmlIntoFile(
        target.uri,
        generation.generatedXml,
        undefined,
        generation.fragmentDefinition,
        affectingTokens,
        generation.tokenDefinitions
      );
      await openInjectionReport(currentFileResults, target.uri, generation.generatedXml);
      vscode.window.showInformationMessage(
        `Kahua: Generated fragments for ${fragmentIds.join(', ')} inserted into current file`
      );
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
      break;
    }

    case 'selectFile': {
      const selectFileResults = await insertXmlIntoFile(
        target.uri,
        generation.generatedXml,
        'smart',
        generation.fragmentDefinition,
        affectingTokens,
        generation.tokenDefinitions
      );
      const fileName = getWorkspaceRelativePath(target.uri);
      await openInjectionReport(selectFileResults, target.uri, generation.generatedXml);
      vscode.window.showInformationMessage(
        `Kahua: Generated fragments for ${fragmentIds.join(', ')} inserted into ${fileName}`
      );
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
      break;
    }

    case 'clipboard': {
      await vscode.env.clipboard.writeText(generation.generatedXml);
      vscode.window.showInformationMessage(
        `Kahua: Generated fragments for ${fragmentIds.join(', ')} copied to clipboard`
      );
      break;
    }
  }
}

