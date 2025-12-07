import * as vscode from 'vscode';
import { SaxesParser } from 'saxes';
import * as path from 'path';
// TableGenerationPanel import removed - tables now use document-based approach

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
  readpaths?: string[];  // NEW: Paths to try when reading/extracting the value (in order)
  injectionmatchpaths?: string[];  // NEW: Paths to check for matches during injection (in order)
  attribute?: string;  // For selection type: which attribute to read
  affectsInjection?: boolean;
  injectionPathTemplate?: string;
  
  // DEPRECATED - kept only for migration reference
  path?: string;
  attributeMatchOrderForInjection?: string[];
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
  attributeDisplayConfig?: string;
  attributeDisplayHints?: AttributeDisplayHint[];
  pathSegments?: string[];
}

interface ResolvedInjectionPathConfig extends InjectionPathConfig {
  path: string;
  attributeDisplayHints?: AttributeDisplayHint[];
  pathSegments?: string[];
}

interface HierarchicalInjectionGroup {
  groupSelector: string;
  groupDisplayAttribute: string;
  groupPathToken: string;
}

interface FragmentDefinition {
  id: string;
  name: string;
  type?: 'grouped' | 'table'; // Default is 'grouped'
  tokenReferences: string[];
  applicableDocumentTypes?: string[];
  fragments: Record<string, string | Record<string, string | Record<string, string>>>;
  injectionPaths?: Record<string, string | InjectionPathConfig>;
  hierarchicalInjectionGroups?: Record<string, HierarchicalInjectionGroup>;
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
  kind: 'rootElement' | 'xpathExists' | 'xpathNotExists' | 'attributeExists' | 'attributeNotExists';
  value?: string;
  xpath?: string;
  attribute?: string;
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
  required?: boolean;
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
 * Tracks template documents (generated token templates)
 */
const templateDocumentUris = new Set<string>();
const snippetDocumentUris = new Set<string>();
const tableDocumentUris = new Set<string>();

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
const CAN_GENERATE_TABLES_CONTEXT_KEY = 'kahua.canGenerateTables';
const TEMPLATE_KIND_CONTEXT_KEY = 'kahua.templateKind';
const SNIPPET_KIND_CONTEXT_KEY = 'kahua.snippetKind';
const HAS_SOURCE_FILE_CONTEXT_KEY = 'kahua.hasSourceFile';

// Performance: Conditional debugging
declare const __KAHUA_DEBUG__: boolean | undefined;

const DEBUG_MODE =
  typeof __KAHUA_DEBUG__ !== 'undefined' ? __KAHUA_DEBUG__ : process.env.NODE_ENV !== 'production';
const debugLog = DEBUG_MODE ? console.log : () => {};
const debugWarn = DEBUG_MODE ? console.warn : () => {};
const debugError = DEBUG_MODE ? console.error : () => {};
function logDuration(label: string, startTime: number): void {
  debugLog(`[KAHUA] ${label} completed in ${Date.now() - startTime}ms`);
}

function getAttributeCaseInsensitive(
  attributes: Record<string, string> | undefined,
  attributeName: string
): string | undefined {
  if (!attributes) {
    return undefined;
  }

  if (attributes[attributeName] !== undefined) {
    return attributes[attributeName];
  }

  const matchKey = Object.keys(attributes).find(key => key.toLowerCase() === attributeName.toLowerCase());
  return matchKey ? attributes[matchKey] : undefined;
}

function injectionPathContainsValue(path: string | undefined, value: string): boolean {
  if (!path || !value) {
    return false;
  }
  const escaped = escapeRegExp(value);
  
  // First check: Does value appear quoted in the path? (exact attribute value match)
  const quotedPattern = new RegExp(`['"]${escaped}['"]`, 'i');
  if (quotedPattern.test(path)) {
    return true;
  }
  
  // Second check: Does value appear as a complete token?
  // Token separators: space, slash, brackets, @, =, quotes, dot
  // NOT underscore - underscores are part of identifiers (e.g., "kahua_AEC_RFI" is one token)
  // This ensures "RFI" matches in ".RFI" but not in "_RFI"
  const tokenPattern = new RegExp(`(^|[\\s/\\[\\]@='".])${escaped}($|[\\s/\\[\\]@='".])`, 'i');
  return tokenPattern.test(path);
}

function elementOrAncestorsContainValue(
  element: SaxElement | undefined,
  value: string,
  attributeNames?: string[]
): boolean {
  let current: SaxElement | undefined = element;
  const normalizedAttributes =
    attributeNames && attributeNames.length > 0
      ? attributeNames.map(name => name.toLowerCase())
      : undefined;
  while (current) {
    for (const [attrName, attrValue] of Object.entries(current.attributes || {})) {
      if (normalizedAttributes && !normalizedAttributes.includes(attrName.toLowerCase())) {
        continue;
      }
      if (attrValue === value) {
        return true;
      }
    }
    current = current.parent;
  }
  return false;
}

interface InjectionTokenMetadata {
  tokenName: string;
  matchAttributes: string[];
}

function buildInjectionTokenMetadata(tokenDefinitions?: TokenNameDefinition[]): Map<string, InjectionTokenMetadata> {
  const metadata = new Map<string, InjectionTokenMetadata>();
  if (!tokenDefinitions) {
    return metadata;
  }

  for (const tokenDef of tokenDefinitions) {
    if (!tokenDef.tokenReadPaths) continue;
    for (const [tokenName, readPath] of Object.entries(tokenDef.tokenReadPaths)) {
      if (!readPath?.affectsInjection) {
        continue;
      }
      const matchAttributes = Array.isArray(readPath.attributeMatchOrderForInjection)
        ? readPath.attributeMatchOrderForInjection
            .map(attribute => (typeof attribute === 'string' ? attribute.trim() : ''))
            .filter(attribute => attribute.length > 0 && attribute.toLowerCase() !== 'any')
        : [];
      metadata.set(tokenName, {
        tokenName,
        matchAttributes
      });
    }
  }

  return metadata;
}

function computeTokenMatchScore(
  target: XmlTargetSection,
  tokenValue: string,
  metadata?: InjectionTokenMetadata
): number {
  let score = 0;

  if (injectionPathContainsValue(target.injectionPath, tokenValue)) {
    score += 5;
  }

  if (target.xpathPath && injectionPathContainsValue(target.xpathPath, tokenValue)) {
    score += 2;
  }

  if (target.context && injectionPathContainsValue(target.context, tokenValue)) {
    score += 1;
  }

  if (metadata) {
    if (elementOrAncestorsContainValue(target.element, tokenValue, metadata.matchAttributes)) {
      score += metadata.matchAttributes.length > 0 ? 4 : 3;
    }
  } else if (elementOrAncestorsContainValue(target.element, tokenValue)) {
    score += 2;
  }

  return score;
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
 * Unified CSV Generation Service - Consolidates all CSV creation logic
 * This eliminates the 5+ duplicate CSV generation implementations throughout the codebase
 */
class CsvGenerationService {
  /**
   * Generate CSV content with context headers and data rows
   */
  static generateCsv(options: {
    fragmentIds: string[];
    sourceFile?: string;
    sourceUri?: string;
    headerTokens: ParsedToken[];
    tableTokens: ParsedToken[];
    extractedTokens: Map<string, string>;
    tokenDefinitions?: TokenNameDefinition[];
    dataRows?: any[];
    includeDefaultRow?: boolean;
    snippetMode?: boolean;
    tabStopStartIndex?: number;
  }): string {
    const lines: string[] = [];
    
    // Add context headers
    lines.push(`// Kahua ${options.snippetMode ? 'Snippet' : 'Template'} for ${options.fragmentIds.join(', ').toLowerCase()}`);
    
    if (options.sourceFile) {
      lines.push(`${SOURCE_XML_COMMENT_PREFIX} ${options.sourceFile}`);
    }
    if (options.sourceUri) {
      lines.push(`${SOURCE_XML_URI_PREFIX} ${options.sourceUri}`);
    }
    
    if (!options.snippetMode) {
      // Template-specific header
      lines.push('// Token Template for ' + options.fragmentIds.join(', ').toLowerCase() + ':');
    }
    
    lines.push('// ----------------------------------------------------------------');
    
    // Add context comments for tokens that affect injection
    if (options.tokenDefinitions && options.tokenDefinitions.length > 0) {
      for (const tokenDef of options.tokenDefinitions) {
        if (!tokenDef.tokenReadPaths) continue;
        
        for (const [tokenName, readPath] of Object.entries(tokenDef.tokenReadPaths)) {
          const typedReadPath = readPath as TokenReadPath;
          if (typedReadPath.affectsInjection && options.extractedTokens.has(tokenName)) {
            const tokenValue = options.extractedTokens.get(tokenName)!;
            // Capitalize first letter for display
            const displayName = tokenName.charAt(0).toUpperCase() + tokenName.slice(1);
            lines.push(`// ${displayName} Context: ${tokenValue}`);
            
            // Add special guidance for selection-type tokens (tokens that require user selection)
            if (!options.snippetMode && typedReadPath.type === 'selection') {
              lines.push(`// All template rows will target this ${tokenName}. Update this header if you change ${tokenName}s.`);
              lines.push(`// Smart injection will automatically use this ${tokenName} for path resolution.`);
            }
          }
        }
      }
    }
    
    
    // Add header columns information
    if (options.headerTokens.length > 0) {
      const headerColumnsDisplay = options.headerTokens.map(token => {
        const extractedValue = options.extractedTokens.get(token.name);
        const value = extractedValue || token.defaultValue || token.name;
        const nameDisplay = token.required ? `${token.name} (Required)` : token.name;
        return `${nameDisplay}:${value}`;
      }).join(', ');
      lines.push(`// Header Columns: ${headerColumnsDisplay}`);
    }
    
    // Add table columns information with defaults
    if (options.tableTokens.length > 0) {
      const tableColumnsDisplay = options.tableTokens.map(token => {
        const nameDisplay = token.required ? `${token.name} (Required)` : token.name;
        return token.defaultValue ? `${nameDisplay}:${token.defaultValue}*` : nameDisplay;
      }).join(', ');
      lines.push(`// Table Columns: ${tableColumnsDisplay}`);

      // Add default explanation if any defaults exist
      const hasDefaults = options.tableTokens.some(token => token.defaultValue);
      if (hasDefaults) {
        lines.push('// * = Default value will be applied to new rows');
      }
    }

    if (
      options.headerTokens.some(token => token.required) ||
      options.tableTokens.some(token => token.required)
    ) {
      lines.push('// Columns marked (Required) must be populated before generation');
    }

    lines.push('// ----------------------------------------------------------------');
    if (!options.snippetMode) {
      lines.push('// Edit the template data below and use generation commands');
    }
    lines.push('');
    
    // Add header tokens row if any
    if (options.headerTokens.length > 0) {
      const headerValues = options.headerTokens.map(token => {
        const extractedValue = options.extractedTokens.get(token.name);
        return extractedValue || token.defaultValue || token.name;
      });
      lines.push(headerValues.join(','));
    }
    
    // Add data rows
    if (options.dataRows && options.dataRows.length > 0) {
      // Use provided data rows - snippet mode needs multiple rows with tab stops
      if (options.snippetMode && options.tableTokens.length > 0) {
        let tabStopIndex = options.tabStopStartIndex || 1;
        for (let rowIndex = 0; rowIndex < options.dataRows.length; rowIndex++) {
          const rowParts = options.tableTokens.map(token => {
            const defaultValue = token.defaultValue || '';
            const placeholder = defaultValue ? `\${${tabStopIndex}:${defaultValue}}` : `\${${tabStopIndex}:${token.name}}`;
            tabStopIndex++;
            return placeholder;
          });
          lines.push(rowParts.join(','));
        }
        // Add final tab stop for snippets
        lines.push(`$0`);
      } else {
        // Regular data rows for templates/tables
        const allTokenNames = [...options.headerTokens.map(t => t.name), ...options.tableTokens.map(t => t.name)];
        for (const row of options.dataRows) {
          const rowValues = allTokenNames.map(tokenName => row[tokenName] || '');
          lines.push(rowValues.join(','));
        }
      }
    } else if (options.includeDefaultRow && options.tableTokens.length > 0) {
      // Add default row for editing
      if (options.snippetMode) {
        // Generate snippet with tab stops
        let tabStopIndex = options.tabStopStartIndex || 1;
        const rowParts = options.tableTokens.map(token => {
          const defaultValue = token.defaultValue || '';
          const placeholder = defaultValue ? `\${${tabStopIndex}:${defaultValue}}` : `\${${tabStopIndex}:${token.name}}`;
          tabStopIndex++;
          return placeholder;
        });
        lines.push(rowParts.join(','));
        
        // Add final tab stop
        lines.push(`$0`);
      } else {
        // Regular template with defaults
        const defaultValues = options.tableTokens.map(token => token.defaultValue || '');
        lines.push(defaultValues.join(','));
      }
    }
    
    return lines.join('\n');
  }
  
  /**
   * Generate CSV for table generation with proper header/data separation
   */
  static generateTableCsv(options: {
    headerFields: Record<string, string>;
    headerTokens: ParsedToken[];
    tableRows: any[][];
    tokenDefinitions?: TokenNameDefinition[];
  }): string {
    const lines: string[] = [];
    
    // Add context comments for tokens that affect injection
    if (options.tokenDefinitions && options.tokenDefinitions.length > 0) {
      for (const tokenDef of options.tokenDefinitions) {
        if (!tokenDef.tokenReadPaths) continue;
        
        for (const [tokenName, readPath] of Object.entries(tokenDef.tokenReadPaths)) {
          const typedReadPath = readPath as TokenReadPath;
          if (typedReadPath.affectsInjection && options.headerFields[tokenName]) {
            const displayName = tokenName.charAt(0).toUpperCase() + tokenName.slice(1);
            lines.push(`// ${displayName} Context: ${options.headerFields[tokenName]}`);
          }
        }
      }
      // Add note that values are from table input (not user-selectable)
      lines.push('// Generated from table - values already provided');
    }
    
    // Add header row (from headerFields)
    const headerRow = (options.headerTokens || []).map((token: any) => 
      options.headerFields[token.name] || token.defaultValue || ''
    );
    lines.push(headerRow.join(','));
    
    // Add table data rows
    for (const row of options.tableRows) {
      lines.push(row.join(','));
    }
    
    return lines.join('\n');
  }
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
  xpathPath?: string;           // The proper XPath for injection (without display names)
  element?: SaxElement;
  attributeDisplayHints?: AttributeDisplayHint[];
  pathSegments?: string[];
}

interface XPathMatchedElement {
  tagName: string;
  attributes: Record<string, any>;
  nameAttributeValue?: string;
  enrichedPath: string;
  xpathPath: string;           // The proper XPath for injection (without display names)
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
type InsertionStrategy = 'smart';

/**
 * Result of an injection operation
 */
interface InjectionResult {
  sectionName: string;
  status: 'injected' | 'skipped';
  reason?: 'not-configured' | 'not-found';
}

export interface GeneratedFragmentResult {
  generatedXml: string;
  fragmentDefinition: FragmentDefinition;
  tokenDefinitions: TokenNameDefinition[];
  extractedTokens?: Map<string, string>; // Token values extracted from template content
  generationDetails?: string;
  skippedRows?: string[];
  sourceUri?: string;
}

interface RowTokenData {
  clean: Record<string, string>;
  raw: Record<string, string>;
}

interface AttributeDisplayHint {
  segmentIndex: number;
  attributes: string[];
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
    ViewDef: ['DisplayName', 'Name'],
    Log: ['Label', 'Name']
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

export function __testSmartInjectionResolution(
  sectionName: string,
  targets: any[],
  affectingTokens?: Map<string, string>,
  tokenDefinitions?: TokenNameDefinition[]
): XmlTargetSection | undefined {
  return trySmartInjectionResolution(sectionName, targets as XmlTargetSection[], affectingTokens, tokenDefinitions);
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
  const config = getKahuaConfig(resource);
  const definitions = config.get<DocumentTypeDefinition[]>('documentTypes') || [];
  debugLog(`[KAHUA] getDocumentTypeDefinitions: Found ${definitions.length} definitions for resource ${resource?.fsPath}`);
  if (definitions.length > 0) {
    debugLog(`[KAHUA] getDocumentTypeDefinitions: First definition: ${JSON.stringify(definitions[0])}`);
  }
  return definitions;
}

/**
 * Performance: Simple hash function for content caching
 */
// Export functions for testing
export { XmlParsingService, FragmentValidationService, TokenExtractionService, extractAttributeValue, extractTextContent, extractSelectableValues, findElementsByXPath, getParsedXmlContext, evaluateDocumentTypeRule, compileTemplate, renderTemplate, evaluateExpression, splitIntoGroups, getTokenValues };

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





function getParsedXmlContext(document: vscode.TextDocument): ParsedXmlContext {
  return XmlParsingService.getParsedXmlContext(document);
}

function parseXmlForDocumentTypeDetection(text: string): SaxElement | null | undefined {
  return XmlParsingService.parseXmlForDocumentTypeDetection(text);
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
  debugLog(`[KAHUA] evaluateDocumentTypeRule: kind=${rule.kind}, value=${rule.value}, xpath=${rule.xpath}, rootElement=${rootElementName}`);
  
  switch (rule.kind) {
    case 'rootElement':
      if (!rule.value || !rootElementName) {
        debugLog(`[KAHUA] evaluateDocumentTypeRule: rootElement check failed - rule.value=${rule.value}, rootElementName=${rootElementName}`);
        return false;
      }
      const matches = rootElementName.toLowerCase() === rule.value.toLowerCase();
      debugLog(`[KAHUA] evaluateDocumentTypeRule: rootElement '${rootElementName}' === '${rule.value}' -> ${matches}`);
      return matches;
    case 'xpathExists':
      const existsResult = !!(rule.xpath && hasXmlPath(rootElement || null, rule.xpath));
      debugLog(`[KAHUA] evaluateDocumentTypeRule: xpathExists '${rule.xpath}' -> ${existsResult}`);
      return existsResult;
    case 'xpathNotExists':
      const notExistsResult = !!(rule.xpath) && !hasXmlPath(rootElement || null, rule.xpath);
      debugLog(`[KAHUA] evaluateDocumentTypeRule: xpathNotExists '${rule.xpath}' -> ${notExistsResult}`);
      return notExistsResult;
    case 'attributeExists':
      if (!rule.xpath || !rule.attribute || !rootElement) {
        debugLog(`[KAHUA] evaluateDocumentTypeRule: attributeExists missing params - xpath=${rule.xpath}, attribute=${rule.attribute}, rootElement=${!!rootElement}`);
        return false;
      }
      // For document type detection, we typically check the root element
      if (rule.xpath === 'App' && rootElement) {
        const hasAttribute = rootElement.attributes && rule.attribute in rootElement.attributes;
        debugLog(`[KAHUA] evaluateDocumentTypeRule: attributeExists '${rule.xpath}/@${rule.attribute}' -> ${hasAttribute}`);
        return hasAttribute;
      }
      debugLog(`[KAHUA] evaluateDocumentTypeRule: attributeExists currently only supports 'App' xpath for document type detection`);
      return false;
    case 'attributeNotExists':
      if (!rule.xpath || !rule.attribute || !rootElement) {
        debugLog(`[KAHUA] evaluateDocumentTypeRule: attributeNotExists missing params - xpath=${rule.xpath}, attribute=${rule.attribute}, rootElement=${!!rootElement}`);
        return false;
      }
      // For document type detection, we typically check the root element
      if (rule.xpath === 'App' && rootElement) {
        const lacksAttribute = !rootElement.attributes || !(rule.attribute in rootElement.attributes);
        debugLog(`[KAHUA] evaluateDocumentTypeRule: attributeNotExists '${rule.xpath}/@${rule.attribute}' -> ${lacksAttribute}`);
        return lacksAttribute;
      }
      debugLog(`[KAHUA] evaluateDocumentTypeRule: attributeNotExists currently only supports 'App' xpath for document type detection`);
      return false;
    default:
      debugLog(`[KAHUA] evaluateDocumentTypeRule: unknown rule kind '${rule.kind}'`);
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
      debugLog(`[KAHUA] detectDocumentTypeId: ${definition.id} has no rules, skipping`);
      continue;
    }

    debugLog(`[KAHUA] detectDocumentTypeId: Testing ${definition.id} with ${definition.rules.length} rules`);
    const matches = definition.rules.every(rule => {
      const ruleResult = evaluateDocumentTypeRule(rule, parsedXml, rootName);
      debugLog(`[KAHUA] detectDocumentTypeId: Rule ${rule.kind}=${JSON.stringify(rule)} -> ${ruleResult}`);
      return ruleResult;
    });

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
  const hasApplicable = Boolean(typeId);
  debugLog(`[KAHUA] Setting ${DOCUMENT_APPLICABLE_CONTEXT_KEY} = ${hasApplicable}`);
  
  // CRITICAL DEBUG: Log current active document
  const activeDoc = vscode.window.activeTextEditor?.document;
  debugLog(`[KAHUA] Active document when setting context: ${activeDoc?.fileName || 'none'}`);
  debugLog(`[KAHUA] Active document language: ${activeDoc?.languageId || 'none'}`);
  
  await vscode.commands.executeCommand(
    'setContext',
    DOCUMENT_APPLICABLE_CONTEXT_KEY,
    hasApplicable
  );
  await vscode.commands.executeCommand(
    'setContext',
    DOCUMENT_TYPE_CONTEXT_KEY,
    typeId ?? ''
  );
  
  // CRITICAL DEBUG: Verify context was set by reading it back
  debugLog(`[KAHUA] Context setting completed. hasApplicable=${hasApplicable}, typeId=${typeId}`);
}

async function updateDocumentTypeContext(document?: vscode.TextDocument): Promise<void> {
  if (!document) {
    debugLog('[KAHUA] updateDocumentTypeContext: No active document - preserving source file context');
    await setDocumentTypeContext(undefined);
    await setTemplateDocumentContext(undefined);
    await setSnippetDocumentContext(undefined);
    await setSelectionContext(undefined);
    await updateGenerationAvailability(undefined);
    // DON'T clear source file context - preserve it for webview operations
    // await setSourceFileContext(undefined);
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
  
  // FALLBACK: If full detection fails but this looks like a Kahua file, enable menu anyway
  if (!typeId && isBasicKahuaFile(document)) {
    debugLog(`[KAHUA] updateDocumentTypeContext: Fallback detection - enabling menu for basic Kahua file`);
    await setDocumentTypeContext('basic-kahua'); // Use special fallback type
    return;
  }
  
  await setDocumentTypeContext(typeId);
}

/**
 * Fallback detection for basic Kahua files - shows menu even if full detection fails
 * This prevents menu regression when document type detection has issues
 */
function isBasicKahuaFile(document: vscode.TextDocument): boolean {
  try {
    const content = document.getText();
    if (!content.trim()) {
      return false;
    }
    
    // Quick check for <App> root element without full XML parsing
    const appElementMatch = content.match(/<App[\s>]/i);
    if (appElementMatch) {
      debugLog(`[KAHUA] isBasicKahuaFile: Found <App> root element at position ${appElementMatch.index}`);
      return true;
    }
    
    return false;
  } catch (error) {
    debugLog(`[KAHUA] isBasicKahuaFile: Error checking file: ${error}`);
    return false;
  }
}

function requireDocumentType(document: vscode.TextDocument): string {
  const typeId = getOrDetectDocumentType(document);
  if (!typeId) {
    throw new Error('Could not determine the document type. Please update kahua.documentTypes or open a supported XML file.');
  }
  return typeId;
}

function getDocumentTypeDefinition(document: vscode.TextDocument): DocumentTypeDefinition | undefined {
  const typeId = requireDocumentType(document);
  const config = getKahuaConfig(currentResource());
  const definitions = config.get<DocumentTypeDefinition[]>('documentTypes') || [];
  return definitions.find(def => def.id === typeId);
}

/**
 * Unified Fragment Validation Service - consolidates all fragment validation operations
 */
class FragmentValidationService {
  /**
   * Check if a fragment is applicable to a specific document type
   */
  static isFragmentApplicableToDocument(fragment: FragmentDefinition, documentType: string): boolean {
    return !fragment.applicableDocumentTypes || fragment.applicableDocumentTypes.includes(documentType);
  }

  /**
   * Filter and validate fragments for document type compatibility
   */
  static enforceFragmentApplicability(
    fragments: FragmentDefinition[],
    documentType: string
  ): FragmentDefinition[] {
    debugLog(`[KAHUA] enforceFragmentApplicability: documentType="${documentType}", fragments:`, fragments.map(f => ({id: f.id, name: f.name, applicableDocumentTypes: f.applicableDocumentTypes})));
    
    const incompatible = fragments.filter(
      fragment => fragment.applicableDocumentTypes && !fragment.applicableDocumentTypes.includes(documentType)
    );

    if (incompatible.length > 0) {
      const names = incompatible.map(f => f.name || f.id).join(', ');
      debugLog(`[KAHUA] Incompatible fragments for documentType "${documentType}":`, incompatible);
      throw new Error(`Fragment(s) not available for document type "${documentType}": ${names}.`);
    }

    return fragments;
  }

  /**
   * Get fragments by IDs and validate compatibility with document type
   */
  static getValidatedFragments(
    fragmentDefinitions: FragmentDefinition[],
    fragmentIds: string[],
    documentType: string
  ): FragmentDefinition[] {
    // First filter by requested IDs
    const selectedFragmentDefsRaw = fragmentDefinitions.filter(def => fragmentIds.includes(def.id));
    
    if (selectedFragmentDefsRaw.length === 0) {
      throw new Error(`No matching fragment definitions found for: ${fragmentIds.join(', ')}`);
    }

    // Then validate compatibility and return filtered list
    return this.enforceFragmentApplicability(selectedFragmentDefsRaw, documentType);
  }

  /**
   * Get all applicable fragments for a document type
   */
  static getApplicableFragments(
    fragmentDefinitions: FragmentDefinition[],
    documentType: string
  ): FragmentDefinition[] {
    const applicableFragments = fragmentDefinitions.filter(def => 
      this.isFragmentApplicableToDocument(def, documentType)
    );
    
    if (applicableFragments.length === 0) {
      vscode.window.showWarningMessage(`No fragments are configured for document type "${documentType}".`);
      return [];
    }

    return applicableFragments;
  }

  /**
   * Collect all unique token references from a set of fragments
   */
  static collectTokenReferences(fragments: FragmentDefinition[]): Set<string> {
    const allTokenReferences = new Set<string>();
    fragments.forEach(def => {
      def.tokenReferences.forEach(ref => allTokenReferences.add(ref));
    });
    return allTokenReferences;
  }
}

/**
 * Unified Token Extraction Service - consolidates token extraction operations
 */
class TokenExtractionService {
  /**
   * Extract token values from XML document using token definitions
   */
  static async extractTokenValuesFromXml(
    document: vscode.TextDocument,
    tokenDefinitions: TokenNameDefinition[],
    allTokenReferences: Set<string>
  ): Promise<Map<string, string>> {
    const extractedValues = new Map<string, string>();
    
    try {
      const referencedTokenDefs = tokenDefinitions.filter(def =>
        allTokenReferences.has(def.id)
      );
      
      for (const tokenDef of referencedTokenDefs) {
        if (!tokenDef.tokenReadPaths) continue;
        
        try {
          const values = await readTokenValuesFromXml(document, tokenDef.tokenReadPaths);
          debugLog(`[DEBUG] Got ${values.size} values from readTokenValuesFromXml`);
          values.forEach((value, key) => extractedValues.set(key, value));
        } catch (tokenError) {
          debugLog(`[DEBUG] Error reading token values for ${tokenDef.id}:`, tokenError instanceof Error ? tokenError.message : String(tokenError));
          // Continue with other tokens even if one fails
        }
      }
    } catch (error) {
      debugLog(`[DEBUG] Error in extractTokenValuesFromXml:`, error instanceof Error ? error.message : String(error));
    }
    
    debugLog(`[DEBUG] Total extracted values: ${extractedValues.size}`);
    return extractedValues;
  }

  /**
   * Handle selection token with user prompt if needed
   * Generic method that works for any token requiring user selection (entity, category, etc.)
   */
  static async handleSelectionTokenPrompt(
    tokenName: string,
    sourceXmlDocument: vscode.TextDocument | undefined,
    tokenDefinitions: TokenNameDefinition[],
    allTokenReferences: Set<string>,
    extractedValues: Map<string, string>
  ): Promise<string | undefined> {
    if (!sourceXmlDocument) {
      return undefined;
    }

    const referencedTokenDefs = tokenDefinitions.filter(def =>
      allTokenReferences.has(def.id)
    );
    const selectionReadPath = referencedTokenDefs
      .map((def: TokenNameDefinition) => def.tokenReadPaths?.[tokenName])
      .find((readPath?: TokenReadPath) => readPath && readPath.type === 'selection');

    if (!selectionReadPath) {
      return undefined;
    }

    const attributeName = selectionReadPath.attribute || 'Name';
    const configuredPath = selectionReadPath.path;
    let options: Array<{ value: string; context: string }> = [];

    if (configuredPath) {
      options = extractSelectableValues(sourceXmlDocument, configuredPath, attributeName);
    }

    if (options.length > 0) {
      const picked = await showValueSelectionPick(tokenName, options);
      if (picked) {
        extractedValues.set(tokenName, picked);
        return picked;
      }
    } else {
      debugLog(`[DEBUG] No options available for ${tokenName} in source XML document`);
    }

    return undefined;
  }

  /**
   * Extract tokens from template comments (comprehensive parser)
   */
  static extractTokensFromTemplateComments(document: vscode.TextDocument): Map<string, string> {
    const extractedTokens = new Map<string, string>();
    const content = document.getText();
    debugLog('[KAHUA] extractTokensFromTemplateComments: Document content:', content);
    const lines = content.split(/\r?\n/);
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      
      // Parse context comments like "// TokenName Context: Value"
      // This handles Entity Context, Appname Context, Baseapp Context, or any other token
      const contextMatch = trimmedLine.match(/^\/\/\s*(\w+) Context:\s*(.+)$/);
      if (contextMatch && contextMatch[1] && contextMatch[2]) {
        const tokenName = contextMatch[1].toLowerCase();
        const tokenValue = contextMatch[2];
        
        // Skip placeholder values
        if (tokenValue.startsWith('<Select ')) {
          continue;
        }
        
        extractedTokens.set(tokenName, tokenValue);
        debugLog(`[KAHUA] Extracted ${tokenName} from template comments: ${tokenValue}`);
        continue;
      }
      
      // Parse "// Header tokens: appname:MyApp, entity:Field" format
      const headerTokensMatch = trimmedLine.match(/^\/\/\s*Header tokens:\s*(.+)$/);
      if (headerTokensMatch) {
        const tokenPairs = headerTokensMatch[1].split(',').map(pair => pair.trim());
        for (const pair of tokenPairs) {
          const colonIndex = pair.indexOf(':');
          if (colonIndex > 0) {
            const tokenName = pair.substring(0, colonIndex).trim();
            const tokenValue = pair.substring(colonIndex + 1).trim();
            if (tokenName && tokenValue) {
              extractedTokens.set(tokenName, tokenValue);
              debugLog(`[DEBUG] Extracted token from template comments: ${tokenName}=${tokenValue}`);
            }
          }
        }
        continue;
      }
      
      // If we hit a non-comment line that doesn't match, stop processing  
      if (!trimmedLine.startsWith('//') && trimmedLine !== '') {
        break;
      }
    }
    
    debugLog('[KAHUA] Template tokens extracted:', extractedTokens);
    return extractedTokens;
  }

  /**
   * Merge extracted values with template comment values (template comments take precedence)
   */
  static mergeTokenValues(
    xmlExtractedValues: Map<string, string>,
    templateCommentValues: Map<string, string>,
    tokenDefinitions: TokenNameDefinition[]
  ): Map<string, string> {
    const mergedTokens = new Map<string, string>();
    
    // Start with XML extracted values
    xmlExtractedValues.forEach((value, key) => mergedTokens.set(key, value));
    
    // Override with template comment values for injection-affecting tokens
    for (const [tokenName, tokenValue] of templateCommentValues) {
      const tokenDef = tokenDefinitions.find(def => 
        def.tokenReadPaths && Object.keys(def.tokenReadPaths).includes(tokenName)
      );
      
      if (tokenDef?.tokenReadPaths) {
        const readPath = tokenDef.tokenReadPaths[tokenName];
        if (readPath?.affectsInjection) {
          mergedTokens.set(tokenName, tokenValue);
          debugLog(`[KAHUA] Template comment overrides XML for injection token: ${tokenName}=${tokenValue}`);
        }
      }
    }
    
    return mergedTokens;
  }
}

// Legacy function delegates for backward compatibility
function isFragmentApplicableToDocument(fragment: FragmentDefinition, documentType: string): boolean {
  return FragmentValidationService.isFragmentApplicableToDocument(fragment, documentType);
}

function enforceFragmentApplicability(
  fragments: FragmentDefinition[],
  documentType: string
): FragmentDefinition[] {
  return FragmentValidationService.enforceFragmentApplicability(fragments, documentType);
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

function isTableDocument(document?: vscode.TextDocument): boolean {
  if (!document) {
    return false;
  }
  if (tableDocumentUris.has(document.uri.toString())) {
    return true;
  }
  return looksLikeTableDocument(document);
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

function looksLikeTableDocument(document: vscode.TextDocument): boolean {
  for (let i = 0; i < Math.min(10, document.lineCount); i++) {
    const text = document.lineAt(i).text.trim();
    if (!text) {
      continue;
    }
    return text.toLowerCase().startsWith('// kahua table for ');
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
  injectionAffectingTokens.delete(key);
}

function markTemplateDocument(document: vscode.TextDocument): void {
  const key = document.uri.toString();
  templateDocumentUris.add(key);
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
    !isSnippetDocument(document) &&
    !isTableDocument(document);

  debugLog(`[KAHUA] updateGenerationAvailability: document=${document?.uri.fsPath ?? 'none'}, canGenerate=${canGenerate}`);
  if (document) {
    debugLog(`[KAHUA]   - languageId=${document.languageId}, isTemplate=${isTemplateDocument(document)}, isSnippet=${isSnippetDocument(document)}, isTable=${isTableDocument(document)}`);
  }

  const contextManager = KahuaContextManager.getInstance();
  await contextManager.setGenerationAvailable(canGenerate);
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

function markDocumentAsTable(document: vscode.TextDocument, documentType: string): void {
  const key = document.uri.toString();
  tableDocumentUris.add(key);  // ✅ Fixed: Use correct collection
  documentTypeOverrides.set(key, documentType);
  
  // Update context since this document is now a table
  const activeDocument = vscode.window.activeTextEditor?.document;
  if (activeDocument && activeDocument.uri.toString() === key) {
    void setSourceFileContext(activeDocument);
  }
}

function unmarkSnippetDocument(document: vscode.TextDocument): void {
  const key = document.uri.toString();
  snippetDocumentUris.delete(key);
  documentTypeOverrides.delete(key);
  injectionAffectingTokens.delete(key);
}

function unmarkTableDocument(document: vscode.TextDocument): void {
  const key = document.uri.toString();
  tableDocumentUris.delete(key);
  documentTypeOverrides.delete(key);
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
    debugError('[KAHUA] Failed to open source XML document for context:', error);
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

function storeInjectionTokensForDocument(
  documentUri: vscode.Uri,
  tokenDefinitions: TokenNameDefinition[] | undefined,
  extractedTokens: Map<string, string>
): void {
  if (!tokenDefinitions || tokenDefinitions.length === 0) {
    return;
  }

  const affectingTokens = new Map<string, string>();
  for (const tokenDef of tokenDefinitions) {
    if (!tokenDef.tokenReadPaths) {
      continue;
    }
    for (const [tokenName, readPath] of Object.entries(tokenDef.tokenReadPaths)) {
      if (readPath.affectsInjection && extractedTokens.has(tokenName)) {
        affectingTokens.set(tokenName, extractedTokens.get(tokenName)!);
      }
    }
  }

  if (affectingTokens.size > 0) {
    injectionAffectingTokens.set(documentUri.toString(), affectingTokens);
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
        debugWarn('[KAHUA] Failed to parse Source XML URI metadata:', error);
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
      detail: 'Insert into the current XML file using smart injection',
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
 * Inserts XML content into a file with smart section-aware insertion.
 * Returns injection results for reporting.
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
    if (vscode.window.activeTextEditor?.document.uri.toString() !== uri.toString()) {
      debugLog(`[KAHUA] Bringing existing editor to focus: ${uri.fsPath}`);
      await vscode.window.showTextDocument(existingEditor.document, { preserveFocus: false, preview: false });
    } else {
      debugLog(`[KAHUA] File already active, no need to show: ${uri.fsPath}`);
    }
  } else {
    // File is not open - open it in a new editor
    debugLog(`[KAHUA] Opening new editor for file: ${uri.fsPath}`);
    editor = await vscode.window.showTextDocument(document, {
      preserveFocus: false,
      preview: false
    });
  }

  // Smart insertion - get injection paths from the fragment definition
  let rawInjectionPaths: Record<string, string | InjectionPathConfig> = fragmentDefinition?.injectionPaths || {};
  
  // Handle hierarchical injection groups (e.g., HubDef containers)
  if (fragmentDefinition?.hierarchicalInjectionGroups && xmlContext) {
    rawInjectionPaths = await processHierarchicalInjectionGroups(
      rawInjectionPaths, 
      fragmentDefinition.hierarchicalInjectionGroups, 
      xmlContext,
      affectingTokens,
      tokenDefinitions
    );
  }
  
  let injectionPaths: Record<string, ResolvedInjectionPathConfig> = resolveInjectionPaths(rawInjectionPaths);
  
  const results: InjectionResult[] = [];

  // Apply injection path templates based on selected token values
  if (affectingTokens && affectingTokens.size > 0 && tokenDefinitions) {
    const modifiedPaths: Record<string, ResolvedInjectionPathConfig> = {};

    for (const [sectionName, pathConfig] of Object.entries(injectionPaths)) {
      const xpath = pathConfig.path;
      const templateResult = applyInjectionPathTemplate(xpath, affectingTokens, tokenDefinitions);
      const modifiedXPath = templateResult.result;
      if (templateResult.applied && modifiedXPath !== xpath) {
        debugLog(`[DEBUG] Injection path template applied for "${sectionName}": ${xpath} -> ${modifiedXPath}`);
      }
      modifiedPaths[sectionName] = {
        ...pathConfig,
        path: modifiedXPath
      };
    }

    injectionPaths = modifiedPaths;
  }

  debugLog(`[KAHUA] insertXmlIntoFile: starting section mapping (strategy=${strategy ?? 'prompt'})`);
  debugLog('[DEBUG] Generated XML content being parsed:', content);
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

  debugLog('[DEBUG] Generated sections:', generatedSections.map(s => s.name));
  debugLog('[DEBUG] Target sections:', targetSections.map(s => s.tagName));
  const matches = matchSectionsToTargets(generatedSections, targetSections);
  debugLog('[DEBUG] Section matches:', Array.from(matches.entries()).map(([name, targets]) => ({name, targets: targets.map(t => t.tagName)})));

  // For sections with multiple targets, prompt user to select which to use
  const selectedTargets = new Map<string, XmlTargetSection[]>();

  for (const [sectionName, targetMatches] of matches.entries()) {
    if (targetMatches.length === 0) {
      selectedTargets.set(sectionName, []);
    } else if (targetMatches.length === 1) {
      selectedTargets.set(sectionName, targetMatches);
    } else {
      // Multiple matches - try smart resolution first, then ask user to select
      const selected = await selectTargetsFromMultiple(sectionName, targetMatches, affectingTokens, tokenDefinitions);
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
  injectionPaths: Record<string, ResolvedInjectionPathConfig>,
  xmlContext: ParsedXmlContext,
  affectingTokens?: Map<string, string>,
  tokenDefinitions?: TokenNameDefinition[]
): XmlTargetSection[] {
  const sections: XmlTargetSection[] = [];

  // Get element display configuration
  const config = getResolvedElementDisplayConfig();

  for (const [sectionName, pathConfig] of Object.entries(injectionPaths)) {
    const xpath = pathConfig.path;
    
    debugLog(`[DEBUG] Processing section "${sectionName}" with xpath: ${xpath}`);

    const templateApplied = applyInjectionPathTemplate(xpath, affectingTokens || new Map(), tokenDefinitions);
    let finalXpath = templateApplied.result;
    debugLog(`[DEBUG] Final xpath after template application: ${finalXpath}`);
    
    // Use hierarchical XPath matching - respects exact path structure
    let candidates = findElementsByHierarchicalXPath(xmlContext, finalXpath, config, document);
    let effectiveXpath = finalXpath;
    if (candidates.length === 0 && finalXpath.includes('[')) {
      const relaxedPath = removeAttributePredicates(finalXpath);
      if (relaxedPath !== finalXpath) {
        debugLog(`[DEBUG] No candidates found for ${finalXpath}, relaxing attribute predicates -> ${relaxedPath}`);
        const relaxedCandidates = findElementsByHierarchicalXPath(xmlContext, relaxedPath, config, document);
        if (relaxedCandidates.length > 0) {
          candidates = relaxedCandidates;
          effectiveXpath = relaxedPath;
          debugLog(`[DEBUG] Found ${relaxedCandidates.length} candidates after relaxing predicates`);
        }
      }
    }
    if (candidates.length === 0 && templateApplied.applied) {
      debugLog(`[DEBUG] No candidates found for xpath: ${finalXpath} after template substitution - falling back to original xpath: ${xpath}`);
      finalXpath = xpath;
      candidates = findElementsByHierarchicalXPath(xmlContext, finalXpath, config, document);
      effectiveXpath = finalXpath;
    }
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
        tagName: sectionName,
        xmlNodeName: tagName,
        openTagLine: line,
        closeTagLine: closeLine,
        lastChildLine,
        indentation,
        isSelfClosing,
        context: candidate.pathSoFar,
        injectionPath: effectiveXpath,
        attributes: element.attributes,
        nameAttributeValue: extractNameAttribute(element, config),
        enrichedPath: candidate.pathSoFar,
        xpathPath: candidate.xpathSoFar,
        element,
        attributeDisplayHints: pathConfig.attributeDisplayHints,
        pathSegments: pathConfig.pathSegments
      });
      
      debugLog(`[DEBUG] Added section for "${sectionName}" at line ${line + 1} with path: ${candidate.pathSoFar}`);
      debugLog(`[DEBUG] Final XPath used: ${finalXpath}, Original XPath: ${xpath}`);
    }
  }

  return sections;
}

/**
 * Extracts token values from template comments like "// Entity Context: RFI"
 * @param document Template document to parse
 * @returns Map of token names to values extracted from comments
 */
export function extractTokensFromTemplateComments(document: vscode.TextDocument): Map<string, string> {
  return TokenExtractionService.extractTokensFromTemplateComments(document);
}

/**
 * Enhanced template replacement that handles multiple token substitutions
 * @param template Template string like "Table[@EntityDefName='{appname}.{entity}']"
 * @param currentTokenName The token being processed (e.g., "entity")
 * @param currentTokenValue The value of the current token (e.g., "Field")
 * @param allTokens Map of all available token values
 */
function applyMultiTokenTemplate(
  template: string,
  currentTokenName: string,
  currentTokenValue: string,
  allTokens: Map<string, string>
): string {
  let result = template;
  
  // First replace {value} with the current token's value (backward compatibility)
  result = result.replace(/{value}/g, currentTokenValue);
  
  // Then replace all other token references
  for (const [tokenName, tokenValue] of allTokens.entries()) {
    const tokenPattern = new RegExp(`\\{${tokenName}\\}`, 'g');
    result = result.replace(tokenPattern, tokenValue);
  }
  
  debugLog(`[DEBUG] Multi-token template: "${template}" -> "${result}" (current: ${currentTokenName}=${currentTokenValue})`);
  debugLog(`[DEBUG] All tokens used in template: ${JSON.stringify(Array.from(allTokens.entries()))}`);
  return result;
}

/**
 * Apply injection path templates with token substitution
 */
export function applyInjectionPathTemplate(
  xpath: string, 
  affectingTokens: Map<string, string>, 
  tokenDefinitions: TokenNameDefinition[] = []
): { success: boolean; result: string; applied: boolean } {
  let modifiedXPath = xpath;
  let applied = false;

  // First, apply general token substitution for any {tokenName} placeholders in the path
  for (const [tokenName, tokenValue] of affectingTokens.entries()) {
    const tokenPattern = new RegExp(`\\{${tokenName}\\}`, 'g');
    if (tokenPattern.test(modifiedXPath)) {
      modifiedXPath = modifiedXPath.replace(tokenPattern, tokenValue);
      applied = true;
      debugLog(`[DEBUG] Applied general token substitution: {${tokenName}} -> ${tokenValue} in path`);
    }
  }

  // Then check each token definition for injection path templates (existing logic)
  for (const tokenDef of tokenDefinitions) {
    if (tokenDef.tokenReadPaths) {
      for (const [tokenName, readPath] of Object.entries(tokenDef.tokenReadPaths)) {
        if (readPath.affectsInjection && readPath.injectionPathTemplate && affectingTokens.has(tokenName)) {
          // Only apply template if the original xpath matches the pattern that the template is for
          // Extract the base path from the template (everything before the filter)
          const templateBasePath = readPath.injectionPathTemplate.split('[')[0];

          // Check if the original xpath matches the path structure that this template is meant for
          // Parse both paths to compare their structural elements
          const xpathParts = xpath.split('/').filter(p => p);
          const templateParts = templateBasePath.split('/').filter(p => p);
          
          // Generic path matching: check if template base path is structurally compatible with xpath
          // Remove attribute filters for structural comparison
          const templateStructure = templateBasePath.replace(/\[@[^\]]+\]/g, '').replace(/^\/+/, '');
          const xpathStructure = xpath.replace(/\[@[^\]]+\]/g, '').replace(/^\/+/, '');
          
          // Check if the template should apply to this xpath
          // The template applies if:
          // 1. For absolute paths (starting with 'App/'), check if one structure starts with the other
          //    This handles cases where the xpath is more specific than the template or vice versa
          // 2. For relative paths or mixed cases, check if one structure contains the other
          //    This ensures structural compatibility
          let shouldApplyTemplate = false;
          
          if (templateStructure.startsWith('App/') && xpathStructure.startsWith('App/')) {
            // Both are absolute paths - use strict prefix matching
            shouldApplyTemplate = 
              xpathStructure.startsWith(templateStructure) || 
              templateStructure.startsWith(xpathStructure);
          } else {
            // For relative or mixed paths - check if structures overlap
            // Split into parts and check if one contains all parts of the other in order
            const templateSegments = templateStructure.split('/').filter(s => s);
            const xpathSegments = xpathStructure.split('/').filter(s => s);
            
            // Check if all template segments appear in xpath in the same order
            let lastFoundIndex = -1;
            const templateInXpath = templateSegments.every(segment => {
              const foundIndex = xpathSegments.indexOf(segment, lastFoundIndex + 1);
              if (foundIndex > lastFoundIndex) {
                lastFoundIndex = foundIndex;
                return true;
              }
              return false;
            });
            
            // Check if all xpath segments appear in template in the same order
            lastFoundIndex = -1;
            const xpathInTemplate = xpathSegments.every(segment => {
              const foundIndex = templateSegments.indexOf(segment, lastFoundIndex + 1);
              if (foundIndex > lastFoundIndex) {
                lastFoundIndex = foundIndex;
                return true;
              }
              return false;
            });
            
            shouldApplyTemplate = templateInXpath || xpathInTemplate;
          }
          
          if (shouldApplyTemplate) {
            const tokenValue = affectingTokens.get(tokenName)!;
            // Enhanced template replacement that handles multiple token substitutions
            modifiedXPath = applyMultiTokenTemplate(readPath.injectionPathTemplate, tokenName, tokenValue, affectingTokens);
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
    result: modifiedXPath,
    applied
  };
}

/**
 * Process hierarchical injection groups (e.g., HubDef containers)
 * Allows grouping injection paths by a common container element like HubDef
 */
async function processHierarchicalInjectionGroups(
  injectionPaths: Record<string, string | InjectionPathConfig>,
  hierarchicalGroups: Record<string, HierarchicalInjectionGroup>,
  xmlContext: ParsedXmlContext,
  affectingTokens?: Map<string, string>,
  tokenDefinitions?: TokenNameDefinition[]
): Promise<Record<string, string | InjectionPathConfig>> {
  const processedPaths: Record<string, string | InjectionPathConfig> = { ...injectionPaths };
  
  for (const [groupName, groupConfig] of Object.entries(hierarchicalGroups)) {
    debugLog(`[DEBUG] Processing hierarchical group: ${groupName}`);
    
    // Auto-detect which injection paths belong to this group by matching the group selector pattern
    const groupSelectorParts = groupConfig.groupSelector.split('/');
    const groupPathPattern = groupSelectorParts.join('/');
    
    // Find injection paths that contain the group pattern
    const affectedSections: string[] = [];
    const originalPaths: Record<string, string> = {};
    
    for (const [sectionName, pathConfig] of Object.entries(injectionPaths)) {
      const xpath = typeof pathConfig === 'string' ? pathConfig : pathConfig.path;
      
      // Check if this injection path contains the hierarchical group pattern
      if (xpath.includes(groupPathPattern)) {
        affectedSections.push(sectionName);
        originalPaths[sectionName] = xpath;
        debugLog(`[DEBUG] Found injection path "${sectionName}" that uses ${groupName}: ${xpath}`);
      }
    }
    
    if (affectedSections.length === 0) {
      debugLog(`[DEBUG] No injection paths found that use group ${groupName}, skipping`);
      continue;
    }
    
    // Find all available group containers (e.g., HubDefs) in the source document
    const groupContainers = findElementsByXPath(xmlContext, groupConfig.groupSelector);
    
    if (groupContainers.length === 0) {
      debugLog(`[DEBUG] No group containers found for selector: ${groupConfig.groupSelector}`);
      continue;
    }
    
    // If only one container, auto-select it
    let selectedContainer: XPathMatchedElement;
    if (groupContainers.length === 1) {
      selectedContainer = groupContainers[0];
      const displayName = selectedContainer.attributes[groupConfig.groupDisplayAttribute] || selectedContainer.tagName;
      debugLog(`[DEBUG] Auto-selecting single ${groupName}: ${displayName}`);
    } else {
      // Multiple containers - prompt user to select
      const containerOptions = groupContainers.map(container => {
        const displayName = container.attributes[groupConfig.groupDisplayAttribute] || container.tagName;
        return {
          label: displayName,
          detail: `${container.enrichedPath}`,
          container
        };
      });
      
      // Add "None" option to skip this group
      containerOptions.push({
        label: "None (Skip injection into this group)",
        detail: "Skip all injections for this container type",
        container: null as any
      });
      
      const selected = await vscode.window.showQuickPick(containerOptions, {
        placeHolder: `Select ${groupName} container for injection`,
        title: `Multiple ${groupName} containers found`
      });
      
      if (!selected || !selected.container) {
        debugLog(`[DEBUG] User skipped ${groupName} selection, removing affected paths`);
        // Remove affected sections from processed paths
        for (const section of affectedSections) {
          delete processedPaths[section];
        }
        continue;
      }
      
      selectedContainer = selected.container;
    }
    
    // Calculate the group path for token substitution using proper XPath format
    // Convert display format "HubDef (ExtendedWorkflow)" to XPath format "HubDef[@Name='ExtendedWorkflow']"
    const groupPath = convertEnrichedPathToXPath(selectedContainer.enrichedPath, selectedContainer.attributes);
    
    // Update injection paths for this group by substituting the group path token
    for (const sectionName of affectedSections) {
      if (sectionName in injectionPaths) {
        const originalPath = originalPaths[sectionName];
        
        // Replace the generic group selector with the specific selected container path
        const expandedPath = originalPath.replace(groupConfig.groupSelector, groupPath);
        
        // Apply any additional injection path templates
        if (affectingTokens && tokenDefinitions) {
          const templateResult = applyInjectionPathTemplate(expandedPath, affectingTokens, tokenDefinitions);
          processedPaths[sectionName] = templateResult.result;
        } else {
          processedPaths[sectionName] = expandedPath;
        }
        
        debugLog(`[DEBUG] Updated ${sectionName}: ${originalPath} -> ${processedPaths[sectionName]}`);
      }
    }
  }
  
  return processedPaths;
}



/**
 * Proper hierarchical XPath traversal - respects exact path structure
 */
function findElementsByHierarchicalXPath(
  xmlContext: ParsedXmlContext, 
  xpath: string,
  config: ElementDisplayConfig,
  document: vscode.TextDocument
): Array<{ element: SaxElement; pathSoFar: string; xpathSoFar: string; candidatesAtLevel: Array<{ element: SaxElement; displayName: string; line: number }> }> {
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
  let currentCandidates: Array<{ element: SaxElement; pathSoFar: string; xpathSoFar: string; candidatesAtLevel: Array<{ element: SaxElement; displayName: string; line: number }> }> = [{ 
    element: root, 
    pathSoFar: root.tagName,
    xpathSoFar: root.tagName,
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
    
    const nextCandidates: Array<{ element: SaxElement; pathSoFar: string; xpathSoFar: string; candidatesAtLevel: Array<{ element: SaxElement; displayName: string; line: number }> }> = [];
    
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
            const xpathSegment = match.displayName ? `${tagName}[@Name='${match.displayName}']` : tagName;
            nextCandidates.push({
              element: match.element,
              pathSoFar: `${candidate.pathSoFar}/${tagName}(${match.displayName})`,
              xpathSoFar: `${candidate.xpathSoFar}/${xpathSegment}`,
              candidatesAtLevel: matchingChildren // Store all candidates at this level for user selection
            });
          }
        } else {
          // Not the final level - continue traversal with each matching child
          for (const match of matchingChildren) {
            const xpathSegment = match.displayName ? `${tagName}[@Name='${match.displayName}']` : tagName;
            nextCandidates.push({
              element: match.element,
              pathSoFar: `${candidate.pathSoFar}/${tagName}(${match.displayName})`,
              xpathSoFar: `${candidate.xpathSoFar}/${xpathSegment}`,
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
 * Unified XML Parsing Service - consolidates all XML parsing operations
 */
class XmlParsingService {
  /**
   * Get cached parsed XML document or parse and cache
   */
  static getCachedParsedXml(document: vscode.TextDocument): SaxElement | null {
    return this.getParsedXmlContext(document).rootElement;
  }

  /**
   * Get full parsed XML context with SAX elements
   */
  static getParsedXmlContext(document: vscode.TextDocument): ParsedXmlContext {
    const existing = parsedXmlContextCache.get(document);
    const content = document.getText();
    const contentHash = simpleHash(content);
    
    if (existing && existing.contentHash === contentHash) {
      // Update document reference in case it changed
      existing.textDocument = document;
      existing.version = document.version;
      debugLog(`[KAHUA] Reusing parsed XML context for ${document.uri.fsPath}`);
      return existing;
    }

    debugLog(`[KAHUA] Building new SAX context for ${document.uri.fsPath}`);
    const start = performance.now();
    
    const rootElement = this.parseXmlDocumentInternal(content);
    const elementsByPath = this.buildElementsByPath(rootElement);
    
    const end = performance.now();
    debugLog(`[KAHUA] Built SAX context with ${elementsByPath.size} element paths for ${document.uri.fsPath} in ${Math.round(end - start)}ms`);

    const result: ParsedXmlContext = {
      textDocument: document,
      version: document.version,
      contentHash,
      rootElement,
      elementsByPath,
      xpathElementCache: new Map(),
      xpathTargetCache: new Map(),
      lineResolutionCache: new Map(),
      pathLineInfo: new Map()
    };
    
    parsedXmlContextCache.set(document, result);
    return result;
  }

  /**
   * Parse XML for document type detection (lightweight)
   */
  static parseXmlForDocumentTypeDetection(text: string): SaxElement | null | undefined {
    try {
      debugLog(`[KAHUA] parseXmlForDocumentTypeDetection: Parsing ${text.length} characters`);
      
      // Performance: Check cache first
      const contentHash = simpleHash(text);
      const cacheKey = `doctype_${contentHash}`;
      const cached = xmlParseCache.get(cacheKey);
      
      if (cached && cached.contentHash === contentHash) {
        cached.timestamp = Date.now(); // Update access time
        debugLog(`[KAHUA] parseXmlForDocumentTypeDetection: Using cached result`);
        return cached.dom;
      }

      const dom = this.parseXmlDocumentInternal(text);
      debugLog(`[KAHUA] parseXmlForDocumentTypeDetection: Parsed DOM, root element: ${dom?.tagName}`);
      
      // Performance: Cache the result
      cleanupXmlCache();
      xmlParseCache.set(cacheKey, {
        dom,
        contentHash,
        timestamp: Date.now()
      });
      
      return dom;
    } catch (error) {
      debugLog(`[KAHUA] parseXmlForDocumentTypeDetection: Error parsing XML: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Build elements by path map for XPath queries
   */
  static buildElementsByPath(rootElement: SaxElement | null): Map<string, SaxElement[]> {
    const elementsByPath = new Map<string, SaxElement[]>();

    if (!rootElement) {
      return elementsByPath;
    }

    this.traverseForPath(rootElement, '', elementsByPath);
    return elementsByPath;
  }

  /**
   * Internal XML parsing function using SAX parser
   */
  static parseXmlDocumentInternal(xmlContent: string): SaxElement | null {
  // Strip BOM if present
  const cleanXmlContent = xmlContent.replace(/^\uFEFF/, '');
  
  const parser = new SaxesParser({ xmlns: false, position: true });
  let rootElement: SaxElement | null = null;
  const elementStack: SaxElement[] = [];
  let currentTextContent = '';

  parser.on('opentag', (tag) => {
    const attributes: Record<string, string> = {};
    
    for (const [key, attr] of Object.entries(tag.attributes)) {
      // SAX attributes should be direct string values, but let's be defensive
      let value: string;
      if (typeof attr === 'string') {
        value = attr;
      } else if (attr && typeof attr === 'object') {
        value = (attr as any).value || (attr as any).nodeValue || String(attr);
      } else {
        value = String(attr || '');
      }
      attributes[key] = value;
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

  const xmlText = cleanXmlContent.replace(/xmlns="[^"]*"/g, '');
  debugLog('[DEBUG] XML content being parsed (first 500 chars):', xmlText.substring(0, 500));
  debugLog('[DEBUG] XML content lines 10-20:', xmlText.split('\n').slice(9, 20));
  parser.write(xmlText).close();

  if (DEBUG_MODE && rootElement) {
    debugLog('[DEBUG] Parsed XML root:', (rootElement as SaxElement).tagName);
  }

  return rootElement;
  }

  /**
   * Traverse SAX element tree and build path map for XPath queries
   */
  private static traverseForPath(element: SaxElement, parentPath: string, elementsByPath: Map<string, SaxElement[]>): void {
    const fullPath = element.path; // Use existing path from SAX element
    
    if (!elementsByPath.has(fullPath)) {
      elementsByPath.set(fullPath, []);
    }
    elementsByPath.get(fullPath)!.push(element);

    // Also add to partial paths for XPath matching
    const pathParts = fullPath.split('/').filter(p => p);
    for (let i = 1; i <= pathParts.length; i++) {
      const partialPath = pathParts.slice(-i).join('/');
      if (!elementsByPath.has(partialPath)) {
        elementsByPath.set(partialPath, []);
      }
      elementsByPath.get(partialPath)!.push(element);
    }

    for (const child of element.children) {
      this.traverseForPath(child, fullPath, elementsByPath);
    }
  }
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
    xpathPath: res.currentEnrichedPath, // For now, use the same path; could be enhanced later
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
 * Determines the appropriate display label for a fragment based on document type.
 * Uses document type detection rather than hardcoded pattern matching.
 */
function getFragmentDisplayLabel(fragmentName: string, document: vscode.TextDocument | null): string {
  if (!document) {
    return fragmentName;
  }
  
  // Use the proper document type detection instead of hardcoded pattern matching
  try {
    const documentType = detectDocumentTypeId(document);
    
    // If the fragment name doesn't suggest it's related to app/extension distinction,
    // just return the original name
    // Only apply special labeling if fragment name explicitly mentions 'app' or 'base'
    const lowerName = fragmentName.toLowerCase();
    const isAppRelated = lowerName.includes('app') || lowerName.includes('base');
    
    if (!isAppRelated) {
      return fragmentName;
    }
    
    // Apply contextual display name based on document type
    if (documentType === 'kahua-extension') {
      return fragmentName.replace(/\b(app|base\s*app)\b/gi, 'Extension');
    } else if (documentType === 'kahua-base') {
      return fragmentName.replace(/\b(app|base\s*app)\b/gi, 'Base App');
    }
    
    return fragmentName;
  } catch (error) {
    // If we can't determine, return original name
    return fragmentName;
  }
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
        // Use new format: readpaths array
        const pathsToTry = readPath.readpaths || [];
        for (const candidatePath of pathsToTry) {
          value = extractAttributeValue(document, candidatePath, xmlContext);
          if (value && value.trim()) {
            break;
          }
        }
        break;

      case 'text':
        // Use first readpath for text extraction
        const textPath = readPath.readpaths?.[0];
        if (textPath) {
          value = extractTextContent(document, textPath, xmlContext);
        }
        break;

      case 'selection':
        if (!readPath.attribute) {
          debugLog(`[DEBUG] Skipping ${tokenName}: no attribute configured`);
          continue;
        }

        // Use first readpath for selection
        const selectionPath = readPath.readpaths?.[0];
        if (!selectionPath) {
          debugLog(`[DEBUG] Skipping ${tokenName}: no readpaths configured`);
          continue;
        }

        debugLog(`[DEBUG] Extracting values for ${tokenName} from path: ${selectionPath}, attribute: ${readPath.attribute}`);
        const options = extractSelectableValues(document, selectionPath, readPath.attribute, xmlContext);
        debugLog(`[DEBUG] Found ${options.length} options:`, options);
        value = await showValueSelectionPick(tokenName, options);
        debugLog(`[DEBUG] User selected: ${value}`);
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
function buildGenerationReport(
  results: InjectionResult[],
  targetFileName: string,
  generationDetails?: string,
  skippedRows?: string[],
  generatedXml?: string
): string {
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

  if (skippedRows && skippedRows.length > 0) {
    report += `Skipped Rows (Missing Required Values):\n`;
    report += `${'-'.repeat(70)}\n`;
    for (const message of skippedRows) {
      report += `  • ${message}\n`;
    }
    report += `\n`;
  }

  if (generationDetails) {
    report += `Generation Details:\n`;
    report += `${'-'.repeat(70)}\n`;
    debugLog('[DEBUG] generateInjectionReport: generationDetails length:', generationDetails.length);
    debugLog('[DEBUG] generateInjectionReport: generationDetails preview (first 1000 chars):', generationDetails.substring(0, 1000));
    debugLog('[DEBUG] generateInjectionReport: Contains unreplaced tokens?', generationDetails.includes('{$'));
    report += generationDetails;
    report += `\n\n`;
  }

  if (generatedXml) {
    report += `Generated Fragments:\n`;
    report += `${'-'.repeat(70)}\n`;
    report += generatedXml;
    report += `\n\n`;
  }

  report += `${'='.repeat(70)}\n`;
  report += `End of Report\n`;

  return report;
}

/**
 * Opens a new editor tab with the injection report
 */
async function openGenerationReport(
  results: InjectionResult[],
  targetFileUri?: vscode.Uri,
  generationDetails?: string,
  skippedRows?: string[],
  generatedXml?: string
): Promise<void> {
  if (results.length === 0 && generationDetails == undefined && (!skippedRows || skippedRows.length === 0)) {
    return;
  }

  const targetFileName = targetFileUri ? getWorkspaceRelativePath(targetFileUri) : '(Not Applicable)';
  const reportText = buildGenerationReport(results, targetFileName, generationDetails, skippedRows, generatedXml);

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
 * Check if a target exactly matches a specific token using configuration-based fallbacks
 * Returns the index of the matching injection path (0 = first/best match), or -1 if no match
 */
function tokenMatchesTarget(
  target: XmlTargetSection,
  tokenName: string,
  tokenValue: string,
  tokenDefinitions?: TokenNameDefinition[]
): number {
  if (!tokenValue) {
    return -1;
  }

  // Get the token's configuration
  let injectionMatchPaths: string[] = [];
  
  if (tokenDefinitions) {
    for (const tokenDef of tokenDefinitions) {
      if (tokenDef.tokenReadPaths?.[tokenName]) {
        const readPath = tokenDef.tokenReadPaths[tokenName];
        
        // Use new format: injectionmatchpaths
        if (readPath.injectionmatchpaths && readPath.injectionmatchpaths.length > 0) {
          injectionMatchPaths = readPath.injectionmatchpaths;
        }
        break;
      }
    }
  }

  // Try each injection match path in order (stop at first match)
  for (let i = 0; i < injectionMatchPaths.length; i++) {
    const matchPath = injectionMatchPaths[i];
    // Check for wildcard: "App/@*" means match ANY attribute on App
    if (matchPath.endsWith('/@*')) {
      const elementPath = matchPath.substring(0, matchPath.length - 3);  // Remove "/@*"
      const element = findAncestorByTag(target.element, elementPath);
      if (element && element.attributes) {
        // Special case: if token value is 'any', match any target with this element
        if (tokenValue.toLowerCase() === 'any') {
          debugLog(`[DEBUG] Token ${tokenName}=any matched via ${matchPath} (universal match) at priority ${i}`);
          return i;
        }
        
        // Check if ANY attribute equals the token value
        for (const [attrName, attrValue] of Object.entries(element.attributes)) {
          if (attrValue === tokenValue) {
            debugLog(`[DEBUG] Token ${tokenName}=${tokenValue} matched via ${matchPath} (${attrName}) at priority ${i}`);
            return i;
          }
        }
      } else if (element && tokenValue.toLowerCase() === 'any') {
        // Element exists but has no attributes, still match if token is 'any'
        debugLog(`[DEBUG] Token ${tokenName}=any matched via ${matchPath} (element exists, universal match) at priority ${i}`);
        return i;
      }
      continue;
    }
    
    // Parse the path to extract element and attribute
    // Format: "App/@Name" or "App/@Extends"
    const pathMatch = matchPath.match(/^(.+)\/@(\w+)$/);
    if (!pathMatch) {
      debugLog(`[DEBUG] Invalid match path format: ${matchPath}`);
      continue;
    }
    
    const elementPath = pathMatch[1];  // e.g., "App"
    const attributeName = pathMatch[2];  // e.g., "Name" or "Extends"
    
    // Find the element (App ancestor in most cases)
    const element = findAncestorByTag(target.element, elementPath);
    if (element && element.attributes) {
      // Case-insensitive attribute lookup
      const matchingKey = Object.keys(element.attributes).find(
        k => k.toLowerCase() === attributeName.toLowerCase()
      );
      const attrValue = matchingKey ? element.attributes[matchingKey] : undefined;
      
      if (attrValue === tokenValue) {
        debugLog(`[DEBUG] Token ${tokenName}=${tokenValue} matched via ${matchPath} at priority ${i}`);
        return i;
      }
    }
  }

  // Also check if value appears as complete token in injection path
  // This is important for tokens like 'entity' that may not have injectionMatchPaths
  if (injectionMatchPaths.length === 0 && injectionPathContainsValue(target.injectionPath, tokenValue)) {
    debugLog(`[DEBUG] Token ${tokenName}=${tokenValue} matched in injection path`);
    return 0; // Default priority
  }

  // Check xpath path and context as well (fallback)
  if (injectionMatchPaths.length === 0) {
    if (target.xpathPath && injectionPathContainsValue(target.xpathPath, tokenValue)) {
      debugLog(`[DEBUG] Token ${tokenName}=${tokenValue} matched in xpath path`);
      return 0; // Default priority
    }

    if (target.context && injectionPathContainsValue(target.context, tokenValue)) {
      debugLog(`[DEBUG] Token ${tokenName}=${tokenValue} matched in context`);
      return 0; // Default priority
    }
  }

  debugLog(`[DEBUG] Token ${tokenName}=${tokenValue} did NOT match target`);
  return -1;
}

/**
 * Check if a target exactly matches ALL tokens
 * Returns the total match score (sum of priorities), or -1 if any token doesn't match
 */
function targetExactlyMatchesAllTokens(
  target: XmlTargetSection,
  tokens: Map<string, string>,
  tokenDefinitions?: TokenNameDefinition[]
): number {
  let totalScore = 0;
  // Every token must match
  for (const [tokenName, tokenValue] of tokens.entries()) {
    const score = tokenMatchesTarget(target, tokenName, tokenValue, tokenDefinitions);
    if (score < 0) {
      return -1; // Any token fails → target doesn't match
    }
    totalScore += score;
  }
  return totalScore; // All tokens matched - return cumulative score (lower is better)
}

/**
 * Attempts to automatically resolve the correct injection target using exact matching.
 * Only auto-injects when exactly ONE target matches ALL tokens exactly.
 */
function trySmartInjectionResolution(
  sectionName: string,
  targets: XmlTargetSection[],
  affectingTokens?: Map<string, string>,
  tokenDefinitions?: TokenNameDefinition[]
): XmlTargetSection | undefined {
  if (!affectingTokens || affectingTokens.size === 0 || targets.length === 0) {
    return undefined;
  }

  const candidateTokens = Array.from(affectingTokens.entries())
    .map(([tokenName, rawValue]) => ({
      tokenName,
      value: (rawValue ?? '').trim()
    }))
    .filter(entry => entry.value.length > 0);

  if (candidateTokens.length === 0) {
    return undefined;
  }

  debugLog(
    `[DEBUG] Smart injection resolution: section=${sectionName}, tokens=${candidateTokens
      .map(entry => entry.tokenName + '=' + entry.value)
      .join(', ')}, targets=${targets.length}`
  );

  // Find targets that exactly match ALL tokens with their scores
  const exactMatches: Array<{ target: XmlTargetSection; score: number }> = [];
  
  for (const target of targets) {
    const tokensMap = new Map(candidateTokens.map(t => [t.tokenName, t.value]));
    
    const score = targetExactlyMatchesAllTokens(target, tokensMap, tokenDefinitions);
    if (score >= 0) {
      exactMatches.push({ target, score });
      debugLog(
        `[DEBUG] Target ${target.context || target.injectionPath} EXACTLY matches all tokens (score: ${score})`
      );
    } else {
      debugLog(
        `[DEBUG] Target ${target.context || target.injectionPath} does NOT match all tokens`
      );
    }
  }

  // If we have matches, pick the one with the best (lowest) score
  if (exactMatches.length > 0) {
    // Sort by score (lowest first)
    exactMatches.sort((a, b) => a.score - b.score);
    
    const bestMatch = exactMatches[0];
    
    // If there are multiple matches with the same score, don't auto-inject (ambiguous)
    if (exactMatches.length > 1 && exactMatches[1].score === bestMatch.score) {
      debugLog(
        `[DEBUG] Multiple targets have the same score (${bestMatch.score}) - cannot auto-inject (ambiguous)`
      );
      return undefined;
    }
    
    debugLog(
      `[DEBUG] Smart injection selected ${
        bestMatch.target.context || bestMatch.target.injectionPath || bestMatch.target.tagName
      } for section "${sectionName}" (exact match with score ${bestMatch.score})`
    );
    return bestMatch.target;
  }

  debugLog(`[DEBUG] No targets exactly match all tokens for section "${sectionName}"`);
  return undefined;
}

function findAncestorByTag(element: SaxElement | undefined, tagName: string): SaxElement | undefined {
  let current = element?.parent;
  const targetTag = tagName.toLowerCase();
  while (current) {
    if (current.tagName.toLowerCase() === targetTag) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * Shows a quick pick for selecting target locations when there are multiple matches
 * Returns the selected targets, or undefined if cancelled
 */
type TargetSelectionItem = vscode.QuickPickItem & {
  target: XmlTargetSection | null;
  picked: boolean;
};

async function selectTargetsFromMultiple(
  sectionName: string,
  targets: XmlTargetSection[],
  affectingTokens?: Map<string, string>,
  tokenDefinitions?: TokenNameDefinition[]
): Promise<XmlTargetSection[] | undefined> {
    if (targets.length === 0) {                                                                                                                                                                                                                                                                                                                                                                          
      return undefined;                                                                                                                                                                                                                                                                                                                                                                                  
    }
                                                                                                                                                                                                                                                                                                                                                                                                         
    if (targets.length === 1) {                                                                                                                                                                                                                                                                                                                                                                          
      return targets;                                                                                                                                                                                                                                                                                                                                                                                    
    }                                                                                                                                                                                                                                                                                                                                                                                                    
                                                                                                                                                                                                                                                                                                                                                                                                         
    const smartSelected = trySmartInjectionResolution(sectionName, targets, affectingTokens, tokenDefinitions);                                                                                                                                                                                                                                                                                                           
    if (smartSelected) {                                                                                                                                                                                                                                                                                                                                                                                 
      debugLog(`[DEBUG] Smart injection auto-resolved to: ${smartSelected.context} (${smartSelected.injectionPath})`);                                                                                                                                                                                                                                                                                   
      debugLog(`[KAHUA] Smart injection: Auto-selected injection target for "${sectionName}" based on template tokens`);                                                                                                                                                                                                                                                                              
      return [smartSelected];                                                                                                                                                                                                                                                                                                                                                                            
    }                                                                                                                                                                                                                                                                                                                                                                                                    
                                                                                                                                                                                                                                                                                                                                                                                                         
  const items: TargetSelectionItem[] = targets.map(target => {
    const displayInfo = buildAttributeDisplayInfo(target);
    const lineInfo = `Line ${target.openTagLine + 1}`;
    const label = displayInfo.label || lineInfo;
    const detail = displayInfo.detail || target.injectionPath || target.context;
    const item: TargetSelectionItem = {
      label,
      description: undefined,
      detail,
      target,
      picked: false
    };
    return item;
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

export function buildAttributeDisplayInfo(target: XmlTargetSection): { label?: string; detail?: string } {
  const lineInfo = `Line ${target.openTagLine + 1}`;

  if (!target.pathSegments || !target.element) {
    const fallbackLabel = target.nameAttributeValue
      ? `${target.nameAttributeValue} (${lineInfo})`
      : lineInfo;
    return {
      label: fallbackLabel,
      detail: target.context || target.injectionPath
    };
  }

  const segments = target.pathSegments;
  const finalIndex = segments.length - 1;
  const hints = target.attributeDisplayHints || [];
  const valuesBySegment = new Map<number, string>();

  for (const hint of hints) {
    const elementAtSegment = getElementAtSegment(target.element, finalIndex, hint.segmentIndex);
    if (!elementAtSegment) {
      continue;
    }

    const value = getFirstAttributeValue(elementAtSegment, hint.attributes);
    if (value && value.trim()) {
      valuesBySegment.set(hint.segmentIndex, value);
    }
  }

  const detailParts = segments.map((segment, index) => {
    const base = segment.replace(/\[.*?\]/g, '').trim() || segment;
    const attrValue = valuesBySegment.get(index);
    return attrValue ? `${base} (${attrValue})` : base;
  });

  const detailText = detailParts.length > 0
    ? detailParts.join('/')
    : (target.context || target.injectionPath);

  if (valuesBySegment.size === 0) {
    const fallbackLabel = target.nameAttributeValue
      ? `${target.nameAttributeValue} (${lineInfo})`
      : lineInfo;
    return {
      label: fallbackLabel,
      detail: detailText
    };
  }

  const sortedIndices = Array.from(valuesBySegment.keys()).sort((a, b) => b - a);
  const preferredValue = valuesBySegment.get(sortedIndices[0]);
  const label = preferredValue ? `${preferredValue} (${lineInfo})` : undefined;

  return {
    label,
    detail: detailText
  };
}

function getElementAtSegment(element: SaxElement, finalIndex: number, targetIndex: number): SaxElement | undefined {
  let current: SaxElement | undefined = element;
  let steps = finalIndex - targetIndex;
  while (current && steps > 0) {
    current = current.parent;
    steps--;
  }
  return steps === 0 ? current : undefined;
}

function getFirstAttributeValue(element: SaxElement, attributes: string[]): string | undefined {
  for (const attr of attributes) {
    const value = element.attributes[attr];
    if (value && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function isSectionConfigured(sectionName: string, injectionPaths: Record<string, ResolvedInjectionPathConfig>): boolean {
  return Object.prototype.hasOwnProperty.call(injectionPaths, sectionName);
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
    debugLog(`[DEBUG] Matching generated section "${genSection.name}" (normalized: "${normalizedName}")`);
    const originalName = genSection.name.trim();
    const normalizedOriginal = originalName.toLowerCase();

    for (const targetSection of targetSections) {
      const targetName = targetSection.tagName.toLowerCase();
      debugLog(`[DEBUG] Checking target "${targetSection.tagName}" (normalized: "${targetName}") against "${normalizedName}"`);
      // Exact match first
      if (normalizedOriginal === targetName) {
        debugLog(`[DEBUG] Exact match found: "${originalName}" === "${targetSection.tagName}"`);
        allMatches.push(targetSection);
        continue;
      }
    }

    if (allMatches.length === 0) {
      debugWarn(
        `[KAHUA] No exact target match found for section "${genSection.name}". Available targets: ${targetSections
          .map(s => s.tagName)
          .join(', ')}`
      );
    }

    debugLog(`[DEBUG] Final matches for "${genSection.name}": ${allMatches.length} targets`);
    matches.set(genSection.name, allMatches);
  }

  return matches;
}

/**
 * Converts an enriched path with display names back to proper XPath format
 * Example: "App/App.HubDefs/HubDef (ExtendedWorkflow)" -> "App/App.HubDefs/HubDef[@Name='ExtendedWorkflow']"
 */
function convertEnrichedPathToXPath(enrichedPath: string, elementAttributes: Record<string, any>): string {
  // For simple cases without display names, return as-is
  if (!enrichedPath.includes('(')) {
    return enrichedPath;
  }
  
  // Convert display format segments to proper XPath format
  return enrichedPath.replace(/(\w+)\s*\(([^)]+)\)/g, (match, tagName, displayName) => {
    // Use Name attribute by default, but could be enhanced to check other attributes
    return `${tagName}[@Name='${displayName}']`;
  });
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
/**
 * Common data model for all generation types
 */
export interface GenerationContext {
  editor: vscode.TextEditor;
  documentType: string;
  fragmentIds: string[];
  fragmentDefinitions: FragmentDefinition[];
  tokenDefinitions: TokenNameDefinition[];
  extractedTokens: Map<string, string>;
}

interface GenerationData {
  headerTokens: ParsedToken[];
  tableTokens: ParsedToken[];
  extractedTokens: Map<string, string>;
  selectedFragmentDefs: FragmentDefinition[];
  templateLines?: string[];
  defaultRowCount?: number;
}

/**
 * Unified generation request - all UI types produce this
 */
export interface GenerationRequest {
  fragmentIds: string[];
  documentType: string;
  outputTarget: OutputTarget;
  tokenData: {
    headerTokens: ParsedToken[];
    tableTokens: ParsedToken[];
    extractedTokens: Map<string, string>;
  };
  dataRows: Array<Record<string, string>>; // Structured data rows
  selectedFragmentDefs: FragmentDefinition[];
  tokenDefinitions: TokenNameDefinition[];
  sourceUri?: string; // Source XML file URI for injection
  skippedRows?: string[];
  fromWebviewTable?: boolean; // Indicates this came from the table webview UI
}

/**
 * Unified generation result - what the generation pipeline produces
 */
interface GenerationResult {
  generatedXml: string;
  fragmentDefinition: FragmentDefinition;
  tokenDefinitions: TokenNameDefinition[];
  extractedTokens: Map<string, string>;
  generationDetails?: string;
  skippedRows?: string[];
  sourceUri?: string;
}

/**
 * Unified handler for all generation commands - implements consistent prework
 */
/**
 * Common prework for all generation commands
 */
async function prepareGenerationContext(generationType: string): Promise<GenerationContext | null> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('No active editor found.');
    return null;
  }

  // Check if current document is a valid Kahua document
  const docTypeId = detectDocumentTypeId(editor.document);
  if (!docTypeId) {
    vscode.window.showWarningMessage('This command is only available in valid Kahua documents.');
    return null;
  }

  if (isTemplateDocument(editor.document) || isSnippetDocument(editor.document) || isTableDocument(editor.document)) {
    vscode.window.showInformationMessage(`Kahua: Generate ${generationType} commands are only available while editing a source XML file.`);
    return null;
  }

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

  const pick = await selectFragments(`Select fragments for ${generationType} generation`, documentType);
  if (!pick) {
    return null;
  }

  // Validate fragment ids are known
  const unknown = pick.fragments.filter(id => !fragmentDefinitions.some(d => d.id === id));
  if (unknown.length) {
    throw new Error(`Menu references unknown fragment id(s): ${unknown.join(', ')}. Use FragmentDefinition.id (not 'name').`);
  }

  // Extract token values from source XML
  const extractedTokens = new Map<string, string>();
  const referencedTokenDefs = tokenDefinitions.filter(def =>
    pick.fragments.some(fragmentId => 
      fragmentDefinitions.find(frag => frag.id === fragmentId)?.tokenReferences.includes(def.id)
    )
  );

  for (const tokenDef of referencedTokenDefs) {
    if (tokenDef.tokenReadPaths) {
      try {
        const values = await readTokenValuesFromXml(editor.document, tokenDef.tokenReadPaths);
        values.forEach((value, key) => extractedTokens.set(key, value));
      } catch (tokenError) {
        // Continue with other tokens even if one fails
      }
    }
  }

  return {
    editor,
    documentType,
    fragmentIds: pick.fragments,
    fragmentDefinitions,
    tokenDefinitions,
    extractedTokens
  };
}

/**
 * Create common generation data from context
 */
async function createGenerationData(context: GenerationContext): Promise<GenerationData> {
  const selectedFragmentDefs = FragmentValidationService.getValidatedFragments(
    context.fragmentDefinitions,
    context.fragmentIds,
    context.documentType
  );
  
  const allTokenReferences = FragmentValidationService.collectTokenReferences(selectedFragmentDefs);

  const { headerTokens, tableTokens } = mergeTokenDefinitions(
    context.tokenDefinitions,
    Array.from(allTokenReferences)
  );

  return {
    headerTokens,
    tableTokens,
    extractedTokens: context.extractedTokens,
    selectedFragmentDefs
  };
}

/**
 * Show appropriate UI based on generation type - returns GenerationRequest when user completes interaction
 */
async function showGenerationUI(generationType: 'template' | 'snippet' | 'table', context: GenerationContext, data: GenerationData): Promise<GenerationRequest | undefined> {
  switch (generationType) {
    case 'template':
      return await showTemplateUI(context, data);
    case 'snippet':
      return await showSnippetUI(context, data);
    case 'table':
      return await showTableUI(context, data);
    default:
      return undefined;
  }
}

/**
 * Template UI implementation - creates editable template document for user interaction
 */
async function showTemplateUI(context: GenerationContext, data: GenerationData): Promise<GenerationRequest | undefined> {
  const { headerTokens, tableTokens, extractedTokens, selectedFragmentDefs } = data;
  
  // Generate template content using unified CSV service
  const fragmentIds = selectedFragmentDefs.map(f => f.id);
  const fragmentName = selectedFragmentDefs.map(f => f.name).join(', ');
  
  const templateContent = CsvGenerationService.generateCsv({
    fragmentIds,
    sourceFile: getWorkspaceRelativePath(context.editor.document.uri),
    sourceUri: context.editor.document.uri.toString(),
    headerTokens,
    tableTokens,
    extractedTokens,
    tokenDefinitions: context.tokenDefinitions,
    includeDefaultRow: true,
    snippetMode: false
  });
  const document = await vscode.workspace.openTextDocument({
    content: templateContent,
    language: 'plaintext'
  });

  const editor = await vscode.window.showTextDocument(document, { preview: false });
  focusTemplateEditorOnLastRow(editor);
  rememberSourceXmlMapping(document.uri, context.editor.document.uri);
  storeInjectionTokensForDocument(document.uri, context.tokenDefinitions, extractedTokens);
  markDocumentAsTemplate(document, context.documentType);
  
  vscode.window.showInformationMessage(`Kahua: Token template opened for ${fragmentName.toLowerCase()}. Edit the data and use generation commands.`);
  
  // Templates are interactive documents - user will edit and trigger generation later
  return undefined;
}

function focusTemplateEditorOnLastRow(editor: vscode.TextEditor) {
  const document = editor.document;
  for (let line = document.lineCount - 1; line >= 0; line--) {
    const text = document.lineAt(line).text;
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith('//')) {
      continue;
    }
    const position = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.Default);
    break;
  }
}

/**
 * Snippet UI implementation - creates snippet document with VS Code snippet placeholders in new editor
 */
async function showSnippetUI(context: GenerationContext, data: GenerationData): Promise<GenerationRequest | undefined> {
  const { headerTokens, tableTokens, extractedTokens, selectedFragmentDefs } = data;
  
  // Get default row count from config
  const config = getKahuaConfig(currentResource());
  const defaultRowCount = config.get<number>('defaultSnippetRows') || 3;
  
  const fragmentIds = selectedFragmentDefs.map(f => f.id);
  const fragmentName = selectedFragmentDefs.map(f => f.name).join(', ');
  
  // Create multiple rows of snippet data for tab navigation
  const dataRows = [];
  for (let i = 0; i < defaultRowCount; i++) {
    dataRows.push({});
  }
  
  // Generate snippet content using unified CSV service  
  const snippetContent = CsvGenerationService.generateCsv({
    fragmentIds,
    sourceFile: getWorkspaceRelativePath(context.editor.document.uri),
    sourceUri: context.editor.document.uri.toString(),
    headerTokens,
    tableTokens,
    extractedTokens,
    tokenDefinitions: context.tokenDefinitions,
    dataRows: dataRows,
    includeDefaultRow: false, // We handle multiple rows via dataRows
    snippetMode: true,
    tabStopStartIndex: 1
  });
  const document = await vscode.workspace.openTextDocument({ language: 'plaintext' });
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  await editor.insertSnippet(new vscode.SnippetString(snippetContent), new vscode.Position(0, 0));
  rememberSourceXmlMapping(document.uri, context.editor.document.uri);
  storeInjectionTokensForDocument(document.uri, context.tokenDefinitions, extractedTokens);
  markDocumentAsSnippet(document, context.documentType);
  
  const rowText = defaultRowCount === 0 
    ? 'no default rows' 
    : defaultRowCount === 1 
      ? '1 default row' 
      : `${defaultRowCount} default rows`;
  vscode.window.showInformationMessage(`Kahua: Snippet document opened for ${fragmentName.toLowerCase()} with ${rowText}. Fill in the values and run generation when ready.`);
  
  // Snippets create documents - user will trigger generation later via commands
  // Return undefined to indicate no immediate generation
  return undefined;
}

/**
 * Table UI implementation - creates interactive webview table with data grid functionality
 */
async function showTableUI(context: GenerationContext, data: GenerationData): Promise<GenerationRequest | undefined> {
  const { headerTokens, tableTokens, extractedTokens, selectedFragmentDefs } = data;
  
  // Import the TableGenerationPanel
  const { TableGenerationPanel } = await import('./panels/TableGenerationPanel');
  
  // Prepare table data for the webview
  const fragmentName = selectedFragmentDefs.map(f => f.name).join(', ');
  const fragmentIds = selectedFragmentDefs.map(f => f.id);
  
  // Create headers ONLY from table tokens (header tokens go in separate header fields area)
  const headers = tableTokens.map(t => t.name);
  
  // Create header fields for display (separate from table columns)
  const headerFields = headerTokens.map(token => ({
    name: token.name,
    value: extractedTokens.get(token.name) || token.defaultValue || '',
    label: token.name.charAt(0).toUpperCase() + token.name.slice(1),
    required: token.required === true
  }));
  
  // Create initial row with defaults ONLY from table tokens
  const initialRow = tableTokens.map(token => token.defaultValue || '');
  
  const tableData = {
    headers,
    headerFields,
    rows: [initialRow],
    fragmentName,
    fragmentIds,
    sourceFile: getWorkspaceRelativePath(context.editor.document.uri),
    sourceUri: context.editor.document.uri.toString(), // Store full URI
    documentType: context.documentType,
    selectedFragmentDefs,
    headerTokens,
    tableTokens,
    tokenDefinitions: context.tokenDefinitions
  };

  // Show the webview table panel
  const extensionUri = vscode.extensions.getExtension('Sammy.kahua-attribute-generator')?.extensionUri;
  if (extensionUri) {
    TableGenerationPanel.render(extensionUri, tableData);
  } else {
    throw new Error('Could not get extension URI for table panel');
  }
  
  // Tables use webview for immediate interaction - return undefined (no immediate generation)
  return undefined;
}

/**
 * Handles generation requests from the table webview
 */
async function handleTableGeneration(data: {
  type: 'newEditor' | 'sourceFile' | 'file';
  fragmentIds: string[];
  headerFields: Record<string, string>;
  tableRows: string[][];
  selectedFragmentDefs: any[];
  headerTokens: ParsedToken[];
  tableTokens: ParsedToken[];
  tokenDefinitions?: TokenNameDefinition[];
  documentType: string;
  sourceFile?: string;
  sourceUri?: string;
}): Promise<void> {
  try {
    debugLog('handleTableGeneration command received with data:', data);
    debugLog('handleTableGeneration started with type:', data.type);
    debugLog('handleTableGeneration sourceUri received:', data.sourceUri);

    const fragmentDefs = (data.selectedFragmentDefs || []) as FragmentDefinition[];
    const headerTokens = data.headerTokens || [];
    const tableTokens = data.tableTokens || [];
    const fragmentIds = (data.fragmentIds && data.fragmentIds.length > 0)
      ? data.fragmentIds
      : fragmentDefs.map(def => def.id);

    if (fragmentIds.length === 0 || fragmentDefs.length === 0) {
      throw new Error('No fragment definitions available for table generation.');
    }

    const resolveSourceUri = (): vscode.Uri | undefined => {
      if (data.sourceUri) {
        return vscode.Uri.parse(data.sourceUri);
      }
      if (data.sourceFile) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
          return vscode.Uri.joinPath(workspaceFolder.uri, data.sourceFile);
        }
      }
      const currentEditor = vscode.window.activeTextEditor;
      return currentEditor?.document.uri;
    };

    let sourceFileUri: vscode.Uri | undefined;
    let outputTarget: OutputTarget;

    switch (data.type) {
      case 'sourceFile':
        sourceFileUri = resolveSourceUri();
        if (!sourceFileUri) {
          throw new Error('No source file available for injection');
        }
        outputTarget = { type: 'sourceFile', uri: sourceFileUri };
        break;

      case 'file': {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          canSelectFiles: true,
          canSelectFolders: false,
          filters: {
            'XML Files': ['xml'],
            'All Files': ['*']
          },
          title: 'Select XML File to Inject Into'
        });

        if (!picked || picked.length === 0) {
          vscode.window.showInformationMessage('Kahua: File selection cancelled');
          return;
        }

        outputTarget = { type: 'selectFile', uri: picked[0] };
        break;
      }

      default:
        outputTarget = { type: 'newEditor' };
    }

    const extractedTokens = new Map<string, string>();
    Object.entries(data.headerFields || {}).forEach(([key, value]) => {
      extractedTokens.set(key, value);
    });

    const headerMissing = collectMissingRequiredTokens(headerTokens, tokenName => {
      const raw = data.headerFields?.[tokenName] ?? extractedTokens.get(tokenName) ?? '';
      return raw;
    });
    if (headerMissing.length > 0) {
      throw new Error(`Missing required header values for: ${headerMissing.join(', ')}`);
    }

    const columnNames = tableTokens.map(token => token.name);
    const dataRows: Record<string, string>[] = [];
    const skippedRowMessages: string[] = [];

    const tableRows = data.tableRows || [];
    for (let rowIndex = 0; rowIndex < tableRows.length; rowIndex++) {
      const row = tableRows[rowIndex];
      if (!row || row.length === 0) {
        continue;
      }

      const rowObj: Record<string, string> = {};
      let hasValue = false;

      columnNames.forEach((columnName, index) => {
        const token = tableTokens[index];
        const rawValue = row[index];
        const value = rawValue ?? token?.defaultValue ?? '';

        if (value.trim().length > 0) {
          hasValue = true;
        }

        rowObj[columnName] = value;
      });

      if (!hasValue) {
        continue;
      }

      const missingRowTokens = collectMissingRequiredTokens(tableTokens, tokenName => rowObj[tokenName]);
      if (missingRowTokens.length > 0) {
        skippedRowMessages.push(`Row ${rowIndex + 1}: ${missingRowTokens.join(', ')}`);
        continue;
      }

      dataRows.push(rowObj);
    }

    if (dataRows.length === 0) {
      const message = skippedRowMessages.length > 0
        ? 'Kahua: All rows were skipped because required values were missing.'
        : 'Kahua: No table rows with data were provided.';
      vscode.window.showWarningMessage(message);
      return;
    }

    const tokenDefinitions =
      (data.tokenDefinitions as TokenNameDefinition[] | undefined) ??
      getKahuaConfig(currentResource()).get<TokenNameDefinition[]>('tokenNameDefinitions') ??
      [];

    const generationRequest: GenerationRequest = {
      fragmentIds,
      documentType: data.documentType,
      outputTarget,
      tokenData: {
        headerTokens,
        tableTokens,
        extractedTokens
      },
      dataRows,
      selectedFragmentDefs: fragmentDefs,
      tokenDefinitions,
      skippedRows: skippedRowMessages,
      sourceUri: (sourceFileUri ?? resolveSourceUri())?.toString(),
      fromWebviewTable: true // Mark this as coming from webview table input
    };

    await executeGeneration(generationRequest);
    debugLog('handleTableGeneration completed successfully');
  } catch (error: unknown) {
    debugError('handleTableGeneration error:', error);
    vscode.window.showErrorMessage(`Table generation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleGenerationCommand(generationType: 'template' | 'snippet' | 'table'): Promise<void> {
  try {
    const context = await prepareGenerationContext(generationType);
    if (!context) return;

    const generationData = await createGenerationData(context);
    const generationRequest = await showGenerationUI(generationType, context, generationData);
    
    if (generationRequest) {
      await executeGeneration(generationRequest);
    }
  } catch (error: unknown) {
    vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Unified generation pipeline - processes GenerationRequest and produces XML
 */
async function executeGeneration(request: GenerationRequest): Promise<void> {
  debugLog('[KAHUA] executeGeneration called with request:', {
    fragmentIds: request.fragmentIds,
    documentType: request.documentType,
    targetType: request.outputTarget.type,
    rowCount: request.dataRows.length
  });

  const result = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Generating XML fragments...",
    cancellable: false
  }, async (progress) => {
    return await generateXmlFromRequest(request, progress);
  });

  if (!result) {
    return;
  }

  await finalizeGeneratedFragments(request.outputTarget, request.fragmentIds, result);
}

/**
 * Core generation engine - converts structured data to XML directly
 * WITHOUT showing any intermediate documents
 */
async function generateXmlFromRequest(
  request: GenerationRequest, 
  progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<GenerationResult | undefined> {
  debugLog('generateXmlFromRequest: Processing structured data directly');
  
  progress.report({ message: 'Generating XML from structured data...' });
  
  const fragmentDef = request.selectedFragmentDefs[0];
  if (!fragmentDef) {
    throw new Error('No fragment definition available');
  }

  const config = getKahuaConfig(currentResource());
  const xmlIndentSize = config.get<number>('xmlIndentSize') || 2;
  const applyFormatting = config.get<boolean>('formatXmlOutput') === true;
  const suppressWarnings = config.get<boolean>('suppressInvalidConditionWarnings') || false;

  const rowTokenData = buildRowTokenDataFromRequest(request);

  const renderResult = renderFragmentSectionsFromRows(
    request.selectedFragmentDefs,
    rowTokenData,
    null,
    applyFormatting,
    xmlIndentSize,
    suppressWarnings
  );

  if (renderResult.warnings.length > 0 && !suppressWarnings) {
    vscode.window.showWarningMessage(`Kahua: ${renderResult.warnings.join('; ')}`);
  }

  let generatedXml = renderResult.sections.join('\n\n');
  if (applyFormatting) {
    generatedXml = formatXml(generatedXml, xmlIndentSize);
  }

  let generationDetails: string | undefined;
  try {
    if (request.dataRows && request.dataRows.length > 0) {
      let sourceFileDisplay: string | undefined;
      if (request.sourceUri) {
        try {
          const parsedSource = vscode.Uri.parse(request.sourceUri);
          sourceFileDisplay = getWorkspaceRelativePath(parsedSource);
        } catch (uriError) {
          debugLog('[DEBUG] Failed to resolve workspace-relative source path:', uriError);
        }
      }

      // For webview table input, generate a table report; for template/snippet, generate CSV template
      if (request.fromWebviewTable) {
        generationDetails = generateTableReport({
          fragmentIds: request.fragmentIds,
          sourceFile: sourceFileDisplay,
          sourceUri: request.sourceUri,
          headerTokens: request.tokenData.headerTokens,
          tableTokens: request.tokenData.tableTokens,
          extractedTokens: request.tokenData.extractedTokens,
          dataRows: request.dataRows
        });
      } else {
        generationDetails = CsvGenerationService.generateCsv({
          fragmentIds: request.fragmentIds,
          sourceFile: sourceFileDisplay,
          sourceUri: request.sourceUri,
          headerTokens: request.tokenData.headerTokens,
          tableTokens: request.tokenData.tableTokens,
          extractedTokens: request.tokenData.extractedTokens,
          tokenDefinitions: request.tokenDefinitions,
          dataRows: request.dataRows,
          includeDefaultRow: false,
          snippetMode: false
        });
      }
    }
  } catch (detailsError) {
    debugLog('[DEBUG] Unable to build generation details for table injection:', detailsError);
  }

  return {
    generatedXml,
    fragmentDefinition: fragmentDef,
    tokenDefinitions: request.tokenDefinitions,
    extractedTokens: request.tokenData.extractedTokens,
    generationDetails,
    skippedRows: request.skippedRows,
    sourceUri: request.sourceUri
  };
}

/**
 * Generate a table report for webview table input
 */
function generateTableReport(options: {
  fragmentIds: string[];
  sourceFile?: string;
  sourceUri?: string;
  headerTokens: ParsedToken[];
  tableTokens: ParsedToken[];
  extractedTokens: Map<string, string>;
  dataRows: Array<Record<string, string>>;
}): string {
  const lines: string[] = [];
  
  lines.push('// Kahua Table Generation Report');
  lines.push(`// Fragment: ${options.fragmentIds.join(', ')}`);
  if (options.sourceFile) {
    lines.push(`// Source XML: ${options.sourceFile}`);
  }
  if (options.sourceUri) {
    lines.push(`// Source XML URI: ${options.sourceUri}`);
  }
  lines.push('// ----------------------------------------------------------------');
  
  // Add header fields
  if (options.headerTokens.length > 0) {
    lines.push('// Header Values:');
    for (const token of options.headerTokens) {
      const value = options.extractedTokens.get(token.name) || '';
      lines.push(`//   ${token.name}: ${value}`);
    }
  }
  
  lines.push('// ----------------------------------------------------------------');
  lines.push('// Table Data:');
  lines.push('//');
  
  // Create table header
  const columnNames = options.tableTokens.map(t => t.name);
  const columnWidths = columnNames.map((name, idx) => {
    const maxDataWidth = Math.max(
      ...options.dataRows.map(row => (row[name] || '').length)
    );
    return Math.max(name.length, maxDataWidth, 8);
  });
  
  // Header row
  const headerRow = columnNames.map((name, idx) => 
    name.padEnd(columnWidths[idx])
  ).join(' | ');
  lines.push(`// ${headerRow}`);
  
  // Separator
  const separator = columnWidths.map(w => '-'.repeat(w)).join('-+-');
  lines.push(`// ${separator}`);
  
  // Data rows
  for (const row of options.dataRows) {
    const dataRow = columnNames.map((name, idx) => 
      (row[name] || '').padEnd(columnWidths[idx])
    ).join(' | ');
    lines.push(`// ${dataRow}`);
  }
  
  lines.push('// ----------------------------------------------------------------');
  lines.push(`// Total Rows: ${options.dataRows.length}`);
  lines.push('');
  
  return lines.join('\n');
}

/**
 * Convert structured data back to CSV format for generation pipeline
 */
function convertStructuredDataToCsv(
  headerFields: Record<string, string>,
  dataRows: Record<string, string>[],
  fragmentDef: any,
  tokenDefinitions?: TokenNameDefinition[]
): string {
  const lines: string[] = [];
  
  // Add context comments for tokens that affect injection
  if (tokenDefinitions && tokenDefinitions.length > 0) {
    for (const tokenDef of tokenDefinitions) {
      if (!tokenDef.tokenReadPaths) continue;
      
      for (const [tokenName, readPath] of Object.entries(tokenDef.tokenReadPaths)) {
        const typedReadPath = readPath as TokenReadPath;
        if (typedReadPath.affectsInjection && headerFields[tokenName]) {
          const displayName = tokenName.charAt(0).toUpperCase() + tokenName.slice(1);
          lines.push(`// ${displayName} Context: ${headerFields[tokenName]}`);
        }
      }
    }
    // Add note that values are from table input (not user-selectable)
    lines.push('// Generated from table - values already provided');
  }
  
  // Add CSV header row (only table columns, not header fields)
  const tableColumns = fragmentDef.tokenReferences;
  lines.push(tableColumns.join(','));
  
  // Add data rows
  for (const row of dataRows) {
    const values = tableColumns.map((col: string) => row[col] || '');
    lines.push(values.join(','));
  }
  
  return lines.join('\n');
}

/**
 * Unified finalization - handles all output targets consistently
 */
async function finalizeGeneratedFragments(
  outputTarget: OutputTarget,
  fragmentIds: string[],
  result: GenerationResult
): Promise<void> {
  const affectingTokens = result.extractedTokens;
  const derivedSourceUri = result.sourceUri ? vscode.Uri.parse(result.sourceUri) : undefined;
  
  // DEBUG: Log what XML we're receiving
  debugLog('[DEBUG] finalizeGeneratedFragments: XML length:', result.generatedXml.length);
  debugLog('[DEBUG] finalizeGeneratedFragments: XML preview (first 500 chars):', result.generatedXml.substring(0, 500));
  debugLog('[DEBUG] finalizeGeneratedFragments: Contains tokens?', result.generatedXml.includes('{$'));
  debugLog('[DEBUG] finalizeGeneratedFragments: affectingTokens:', Array.from(affectingTokens.entries()));

  switch (outputTarget.type) {
    case 'newEditor': {
      // For table webview input, show XML directly without report wrapper
      const content = result.generationDetails 
        ? `${result.generationDetails}\n\nGenerated Fragments:\n${'-'.repeat(70)}\n\n${result.generatedXml}`
        : result.generatedXml;
      
      const newDocument = await vscode.workspace.openTextDocument({
        content: content,
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

    case 'sourceFile': {
      if (!outputTarget.uri) {
        throw new Error('Source file URI not specified');
      }
      const sourceFileResults = await insertXmlIntoFile(
        outputTarget.uri,
        result.generatedXml,
        'smart',
        result.fragmentDefinition,
        affectingTokens,
        result.tokenDefinitions
      );
      const sourceFileName = getWorkspaceRelativePath(outputTarget.uri);
      await openGenerationReport(
        sourceFileResults,
        outputTarget.uri,
        result.generationDetails,
        result.skippedRows,
        result.generatedXml
      );
      vscode.window.showInformationMessage(
        `Kahua: Generated fragments for ${fragmentIds.join(', ')} inserted into ${sourceFileName}`
      );
      break;
    }

    case 'selectFile': {
      if (!outputTarget.uri) {
        throw new Error('Target file URI not specified');
      }
      const selectFileResults = await insertXmlIntoFile(
        outputTarget.uri,
        result.generatedXml,
        'smart',
        result.fragmentDefinition,
        affectingTokens,
        result.tokenDefinitions
      );
      const fileName = getWorkspaceRelativePath(outputTarget.uri);
      await openGenerationReport(
        selectFileResults,
        outputTarget.uri,
        result.generationDetails,
        result.skippedRows,
        result.generatedXml
      );
      vscode.window.showInformationMessage(
        `Kahua: Generated fragments for ${fragmentIds.join(', ')} inserted into ${fileName}`
      );
      break;
    }

    case 'currentFile': {
      if (!outputTarget.uri) {
        throw new Error('Current file URI not specified');
      }
      const currentFileResults = await insertXmlIntoFile(
        outputTarget.uri,
        result.generatedXml,
        outputTarget.insertionStrategy || 'smart',
        result.fragmentDefinition,
        affectingTokens,
        result.tokenDefinitions
      );
      await openGenerationReport(
        currentFileResults,
        outputTarget.uri,
        result.generationDetails,
        result.skippedRows,
        result.generatedXml
      );
      vscode.window.showInformationMessage(
        `Kahua: Generated fragments for ${fragmentIds.join(', ')} inserted into current file`
      );
      break;
    }

    case 'clipboard': {
      await vscode.env.clipboard.writeText(result.generatedXml);
      vscode.window.showInformationMessage(
        `Kahua: Generated fragments for ${fragmentIds.join(', ')} copied to clipboard`
      );
      if (result.generationDetails) {
        await openGenerationReport([], derivedSourceUri, result.generationDetails, result.skippedRows, result.generatedXml);
      }
      break;
    }
  }
}

/**
 * Centralized context manager to prevent menu visibility regressions
 */
export class KahuaContextManager {
  private static instance: KahuaContextManager;
  
  static getInstance(): KahuaContextManager {
    if (!KahuaContextManager.instance) {
      KahuaContextManager.instance = new KahuaContextManager();
    }
    return KahuaContextManager.instance;
  }

  async initializeContexts(): Promise<void> {
    debugLog('[KAHUA] Initializing all context variables to defaults');
    // Note: Do NOT set config.kahua.showInContextMenu - that comes from user settings
    await vscode.commands.executeCommand('setContext', DOCUMENT_APPLICABLE_CONTEXT_KEY, false);
    await vscode.commands.executeCommand('setContext', DOCUMENT_TYPE_CONTEXT_KEY, '');
    await vscode.commands.executeCommand('setContext', SELECTION_CONTEXT_KEY, false);
    await vscode.commands.executeCommand('setContext', SNIPPET_DOCUMENT_CONTEXT_KEY, false);
    await vscode.commands.executeCommand('setContext', TEMPLATE_DOCUMENT_CONTEXT_KEY, false);
    await vscode.commands.executeCommand('setContext', CAN_GENERATE_TEMPLATES_CONTEXT_KEY, false);
    await vscode.commands.executeCommand('setContext', CAN_GENERATE_SNIPPETS_CONTEXT_KEY, false);
    await vscode.commands.executeCommand('setContext', CAN_GENERATE_TABLES_CONTEXT_KEY, false);
    await vscode.commands.executeCommand('setContext', TEMPLATE_KIND_CONTEXT_KEY, '');
    await vscode.commands.executeCommand('setContext', SNIPPET_KIND_CONTEXT_KEY, '');
    await vscode.commands.executeCommand('setContext', HAS_SOURCE_FILE_CONTEXT_KEY, false);
  }

  async setDocumentApplicable(hasApplicable: boolean): Promise<void> {
    debugLog(`[KAHUA] Setting ${DOCUMENT_APPLICABLE_CONTEXT_KEY} = ${hasApplicable}`);
    await vscode.commands.executeCommand('setContext', DOCUMENT_APPLICABLE_CONTEXT_KEY, hasApplicable);
  }

  async setGenerationAvailable(canGenerate: boolean): Promise<void> {
    debugLog(`[KAHUA] Setting generation contexts = ${canGenerate}`);
    await vscode.commands.executeCommand('setContext', CAN_GENERATE_TEMPLATES_CONTEXT_KEY, canGenerate);
    await vscode.commands.executeCommand('setContext', CAN_GENERATE_SNIPPETS_CONTEXT_KEY, canGenerate);
    await vscode.commands.executeCommand('setContext', CAN_GENERATE_TABLES_CONTEXT_KEY, canGenerate);
  }

  hasKahuaContext(document: vscode.TextDocument): boolean {
    if (!document || document.languageId !== 'xml') {
      debugLog(
        `[KAHUA] hasKahuaContext: false - document=${!!document}, languageId=${document?.languageId}`
      );
      return false;
    }

    // Use cached detection to avoid reparsing large Kahua files twice.
    const typeId = getOrDetectDocumentType(document);
    if (typeId) {
      debugLog(`[KAHUA] hasKahuaContext: true - typeId=${typeId}, file=${document.uri.fsPath}`);
      return true;
    }

    // As a fallback, treat any <App> XML as applicable so the menu appears quickly.
    const fallback = isBasicKahuaFile(document);
    debugLog(
      `[KAHUA] hasKahuaContext: fallback=${fallback} - no detected type for ${document.uri.fsPath}`
    );
    return fallback;
  }

  async updateContextForDocument(document?: vscode.TextDocument): Promise<void> {
    if (!document) {
      debugLog('[KAHUA] updateContextForDocument: No document - preserving previous context');
      // Don't clear contexts immediately - preserve them for better UX
      // Context will be updated when a new document becomes active
      return;
    }

    const hasContext = this.hasKahuaContext(document);
    debugLog(`[KAHUA] updateContextForDocument: ${document.uri.fsPath} -> hasContext=${hasContext}`);
    
    await this.setDocumentApplicable(hasContext);
    
    const canGenerate = hasContext && 
      !isTemplateDocument(document) && 
      !isSnippetDocument(document) && 
      !isTableDocument(document);
    
    await this.setGenerationAvailable(canGenerate);
  }
}

export async function activate(context: vscode.ExtensionContext) {
  debugLog('[KAHUA] activate() called');
  
  const contextManager = KahuaContextManager.getInstance();
  
  // Initialize all context variables to defaults first
  await contextManager.initializeContexts();
  
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
  
  // Set up event listeners BEFORE setting initial context to prevent race conditions
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      debugLog(`[KAHUA] onDidChangeActiveTextEditor: ${editor?.document.fileName || 'none'}`);
      if (editor?.document) {
        // Update context for the new active document
        void contextManager.updateContextForDocument(editor.document);
        void updateDocumentTypeContext(editor.document);
      } else {
        // No active editor - preserve current context for better UX
        debugLog(`[KAHUA] No active editor - preserving context for webviews/panels`);
      }
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(event => {
      if (event.textEditor === vscode.window.activeTextEditor) {
        void setSelectionContext(event.textEditor);
      }
    })
  );
  
  // NOW set the initial context for any already-open document
  await contextManager.updateContextForDocument(vscode.window.activeTextEditor?.document);
  void updateDocumentTypeContext(vscode.window.activeTextEditor?.document);

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
      
      // If no more text documents are open, clear contexts
      const openTextDocuments = vscode.workspace.textDocuments.filter(doc => 
        doc.uri.scheme === 'file' && !doc.isClosed
      );
      if (openTextDocuments.length === 0) {
        debugLog('[KAHUA] All documents closed - clearing contexts');
        void contextManager.setDocumentApplicable(false);
        void contextManager.setGenerationAvailable(false);
      }
      
      if (templateDocumentUris.has(key)) {
        unmarkTemplateDocument(document);
      } else if (snippetDocumentUris.has(key)) {
        unmarkSnippetDocument(document);
      } else if (tableDocumentUris.has(key)) {
        unmarkTableDocument(document);
      } else {
        documentTypeOverrides.delete(key);
        injectionAffectingTokens.delete(key);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(document => {
      if (document.languageId === 'xml' && isAutoDetectEnabled(document.uri)) {
        void refreshDocumentTypeForDocument(document);
        // If this is the active document, also update context immediately
        if (document === vscode.window.activeTextEditor?.document) {
          void updateDocumentTypeContext(document);
        }
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
      await handleGenerationCommand('template');
    }),
    vscode.commands.registerCommand('kahua.showSnippetForGeneration', async () => {
      await handleGenerationCommand('snippet');
    }),
    vscode.commands.registerCommand('kahua.showTableForGeneration', async () => {
      await handleGenerationCommand('table');
    }),
    vscode.commands.registerCommand('kahua.handleTableGeneration', async (data: any) => {
      await handleTableGeneration(data);
    }),
    // Legacy table generation command removed - tables now use document-based approach
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
    const tokenNamePart = (colonIndex === -1 ? tokenConfig : tokenConfig.slice(0, colonIndex)).trim();
    const isRequired = tokenNamePart.endsWith('!');
    const cleanName = isRequired ? tokenNamePart.slice(0, -1).trim() : tokenNamePart;
    const defaultValue = colonIndex === -1 ? '' : tokenConfig.slice(colonIndex + 1).trim();

    result.push({
      name: cleanName,
      defaultValue,
      required: isRequired
    });
  }
  
  // Performance: Cache the result
  tokenDefinitionCache.set(tokens, result);
  return result;
}

export function collectMissingRequiredTokens(
  tokens: ParsedToken[],
  getValue: (tokenName: string) => string | undefined
): string[] {
  const missing: string[] = [];
  for (const token of tokens) {
    if (!token.required) {
      continue;
    }
    const value = getValue(token.name);
    if (!value || value.trim() === '') {
      missing.push(token.name);
    }
  }
  return missing;
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

function resolveInjectionPaths(
  paths: Record<string, string | InjectionPathConfig>
): Record<string, ResolvedInjectionPathConfig> {
  const resolved: Record<string, ResolvedInjectionPathConfig> = {};
  for (const [sectionName, config] of Object.entries(paths)) {
    resolved[sectionName] = normalizeInjectionPathConfig(config);
  }
  return resolved;
}

function normalizeInjectionPathConfig(config: string | InjectionPathConfig): ResolvedInjectionPathConfig {
  if (typeof config === 'string') {
    const parsed = parseAttributeHintsFromPath(config);
    return {
      path: parsed.path,
      attributeDisplayHints: parsed.hints,
      pathSegments: parsed.segments
    };
  }

  const parsed = parseAttributeHintsFromPath(config.path || '');
  const combinedHints =
    config.attributeDisplayHints && config.attributeDisplayHints.length > 0
      ? config.attributeDisplayHints
      : parsed.hints;

  return {
    ...config,
    path: parsed.path,
    attributeDisplayHints: combinedHints,
    pathSegments: parsed.segments
  };
}

function parseAttributeHintsFromPath(rawPath: string): {
  path: string;
  segments: string[];
  hints: AttributeDisplayHint[];
} {
  const rawSegments = rawPath.split('/').filter(part => part.length > 0);
  const hints: AttributeDisplayHint[] = [];
  const sanitizedSegments = rawSegments.map((segment, index) => {
    // Config strings may contain escaped quotes (\"), so normalize before parsing
    const normalizedSegment = segment.replace(/\\"/g, '"');
    const hintMatch = normalizedSegment.match(/\((?:"[^"]+"(?:\|"[^"]+")*)\)\s*$/);
    if (!hintMatch) {
      return normalizedSegment;
    }

    const hintContent = hintMatch[0];
    const sanitizedSegment = normalizedSegment.slice(0, normalizedSegment.length - hintContent.length);
    const attrList = hintContent
      .slice(1, -1)
      .split('|')
      .map(attr => attr.replace(/"/g, '').trim())
      .filter(attr => attr.length > 0);

    if (attrList.length > 0) {
      hints.push({
        segmentIndex: index,
        attributes: attrList
      });
    }

    return sanitizedSegment;
  });

  return {
    path: sanitizedSegments.join('/'),
    segments: sanitizedSegments,
    hints
  };
}

export function removeAttributePredicates(path: string): string {
  return path.replace(/\[.*?\]/g, '');
}

export function getAttributeCandidatePaths(
  path: string,
  matchOrder?: string[]
): string[] {
  const attrIndex = path.lastIndexOf('/@');
  if (attrIndex === -1 || !matchOrder || matchOrder.length === 0) {
    return [path];
  }

  const basePath = path.slice(0, attrIndex);
  const defaultAttribute = path.slice(attrIndex + 2);
  const normalizedOrder = matchOrder.filter(entry => typeof entry === 'string' && entry.trim().length > 0);
  const candidates: string[] = [];
  const seenAttributes = new Set<string>();

  for (const raw of normalizedOrder) {
    const entry = raw.trim();
    if (entry.toLowerCase() === 'any') {
      if (!seenAttributes.has(defaultAttribute)) {
        candidates.push(`${basePath}/@${defaultAttribute}`);
        seenAttributes.add(defaultAttribute);
      }
      continue;
    }

    if (seenAttributes.has(entry)) {
      continue;
    }

    candidates.push(`${basePath}/@${entry}`);
    seenAttributes.add(entry);
  }

  if (!seenAttributes.has(defaultAttribute)) {
    candidates.push(path);
  }

  return candidates;
}

// Exposed for unit testing of attribute display parsing
export function parseAttributeHintMetadata(path: string) {
  return parseAttributeHintsFromPath(path);
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

function renderFragmentSectionsFromRows(
  fragmentDefs: FragmentDefinition[],
  rowTokenData: RowTokenData[],
  labelDocument: vscode.TextDocument | null,
  applyFormatting: boolean,
  xmlIndentSize: number,
  suppressWarnings: boolean
): { sections: string[]; warnings: string[] } {
  const tableSectionOutputs = new Map<string, { label: string; header?: string; body?: string; footer?: string }>();
  const groupedSectionOutputs = new Map<string, { label: string; body?: string }>();
  const warnings: string[] = [];

  const precomputedFragments = new Map<string, {
    processedFragmentSets: Record<string, Record<string, string>>;
    conditionalFragmentSets: Record<string, ConditionalFragmentEntry[]>;
  }>();

  for (const fragmentDef of fragmentDefs) {
    const { processedFragmentSets, conditionalFragmentSets } = processFragmentTemplates(
      fragmentDef.fragments,
      {},
      {},
      suppressWarnings
    );
    precomputedFragments.set(fragmentDef.id, { processedFragmentSets, conditionalFragmentSets });
  }

  for (const row of rowTokenData) {
    const cleanTokenValues = row.clean;
    const rawTokenValues = row.raw;

    for (const fragmentDef of fragmentDefs) {
      const precomputed = precomputedFragments.get(fragmentDef.id);
      if (!precomputed) {
        continue;
      }

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
            processedFragmentSets[setName][normalizedKey] = entry.template;
          }
        }
      }

      const fragmentType = fragmentDef.type || 'grouped';
      const fragmentLabel = getFragmentDisplayLabel(fragmentDef.name, labelDocument);

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
            warnings.push(...rendered.warnings);
          }

          const bodyTemplate = fragments.body;
          if (bodyTemplate) {
            const rendered = renderTemplate(bodyTemplate, cleanTokenValues, rawTokenValues, suppressWarnings);
            section.body = section.body ? `${section.body}\n${rendered.result}` : rendered.result;
            warnings.push(...rendered.warnings);
          }

          const footerTemplate = fragments.footer;
          if (footerTemplate && !section.footer) {
            const rendered = renderTemplate(footerTemplate, cleanTokenValues, rawTokenValues, suppressWarnings);
            section.footer = rendered.result;
            warnings.push(...rendered.warnings);
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
            warnings.push(...rendered.warnings);
          }
        }
      }
    }
  }

  const sections: string[] = [];

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
      body = formatXml(body, xmlIndentSize);
    }
    sections.push(`\n <!-- ${section.label} -->\n\n${body}`);
  }

  for (const section of groupedSectionOutputs.values()) {
    if (!section.body) {
      continue;
    }
    let body = section.body;
    if (applyFormatting) {
      body = formatXml(body, xmlIndentSize);
    }
    sections.push(`\n <!-- ${section.label} -->\n\n${body}`);
  }

  return { sections, warnings };
}

export function buildRowTokenDataFromRequest(request: GenerationRequest): RowTokenData[] {
  const rows: RowTokenData[] = [];
  const headerTokenValues = new Map<string, string>();

  for (const headerToken of request.tokenData.headerTokens) {
    const rawValue = request.tokenData.extractedTokens.get(headerToken.name) || headerToken.defaultValue || '';
    headerTokenValues.set(headerToken.name, rawValue);
  }

  const headerMissing = collectMissingRequiredTokens(request.tokenData.headerTokens, tokenName => headerTokenValues.get(tokenName));
  if (headerMissing.length > 0) {
    throw new Error(`Missing required header tokens: ${headerMissing.join(', ')}`);
  }

  for (const dataRow of request.dataRows) {
    const clean: Record<string, string> = {};
    const raw: Record<string, string> = {};

    for (const headerToken of request.tokenData.headerTokens) {
      const value = headerTokenValues.get(headerToken.name) || '';
      raw[headerToken.name] = value;
      clean[headerToken.name] = toPascalCase(value || headerToken.defaultValue || '');
    }

    for (const tableToken of request.tokenData.tableTokens) {
      const value = dataRow[tableToken.name] ?? tableToken.defaultValue ?? '';
      raw[tableToken.name] = value;
      clean[tableToken.name] = toPascalCase(value || tableToken.defaultValue || '');
    }

    for (const [key, value] of Object.entries(dataRow)) {
      if (!(key in raw)) {
        raw[key] = value;
        clean[key] = toPascalCase(value);
      }
    }

    const missingTokens = [
      ...collectMissingRequiredTokens(request.tokenData.headerTokens, tokenName => raw[tokenName]),
      ...collectMissingRequiredTokens(request.tokenData.tableTokens, tokenName => raw[tokenName])
    ];
    if (missingTokens.length > 0) {
      throw new Error(`Row ${rows.length + 1}: Missing required tokens (${missingTokens.join(', ')})`);
    }

    rows.push({ clean, raw });
  }

  return rows;
}

/**
 * Shows quickpick for selecting fragments (no filtering - all fragments are equal)
 */
async function selectFragments(
  placeholder: string,
  documentType: string
): Promise<{ label: string; fragments: string[] } | undefined> {
  const config = getKahuaConfig(currentResource());
  const fragmentDefinitions = config.get<FragmentDefinition[]>('fragmentDefinitions') || [];

  if (fragmentDefinitions.length === 0) {
    vscode.window.showErrorMessage('No fragment definitions configured. Please configure kahua.fragmentDefinitions in your settings.');
    return undefined;
  }

  const applicableFragments = FragmentValidationService.getApplicableFragments(fragmentDefinitions, documentType);
  if (applicableFragments.length === 0) {
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

    // Find the fragment definitions we need and validate them
    const selectedFragmentDefs = FragmentValidationService.getValidatedFragments(
      fragmentDefinitions, 
      fragmentIds, 
      documentType
    );

    setGenerationStatus('Preparing fragment generation…', false);

    // Collect all unique token references from selected fragments
    const allTokenReferences = FragmentValidationService.collectTokenReferences(selectedFragmentDefs);
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
 * Get source XML URI for generation - looks for current XML file or remembered source
 */
async function getSourceXmlUriForGeneration(): Promise<vscode.Uri | undefined> {
  // First check if we have an active XML editor
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor && activeEditor.document.languageId === 'xml') {
    return activeEditor.document.uri;
  }

  // Look for any open XML documents
  const openXmlDoc = vscode.workspace.textDocuments.find(doc => 
    doc.languageId === 'xml' && !doc.isUntitled
  );
  
  if (openXmlDoc) {
    return openXmlDoc.uri;
  }

  // If no XML documents are open, ask the user to select one
  const selectedFiles = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { 'XML Files': ['xml'] },
    title: 'Select source XML file for injection'
  });
  
  return selectedFiles && selectedFiles.length > 0 ? selectedFiles[0] : undefined;
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
    debugLog(`[KAHUA] Current resource path: ${currentRes?.fsPath || 'undefined'}`);
    debugLog(`[KAHUA] Current document path: ${currentEditor.document.uri.fsPath}`);
    
    // Try to get configuration from current resource first, then fall back to extension workspace
    let config = getKahuaConfig(currentRes || undefined);
    let tokenDefinitions = config.get<TokenNameDefinition[]>('tokenNameDefinitions') || [];
    let fragmentDefinitions = config.get<FragmentDefinition[]>('fragmentDefinitions') || [];
    
    // If no configuration found in document's workspace, try extension's workspace
    if (tokenDefinitions.length === 0 && fragmentDefinitions.length === 0) {
      debugLog(`[KAHUA] No config in document workspace, trying extension workspace...`);
      
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
        debugLog(`[KAHUA] Trying extension workspace: ${extensionWorkspace.uri.fsPath}`);
        config = getKahuaConfig(extensionWorkspace.uri);
        tokenDefinitions = config.get<TokenNameDefinition[]>('tokenNameDefinitions') || [];
        fragmentDefinitions = config.get<FragmentDefinition[]>('fragmentDefinitions') || [];
      } else {
        // Last resort - try global configuration
        debugLog(`[KAHUA] No workspace found, trying global configuration...`);
        config = getKahuaConfig(undefined);
        tokenDefinitions = config.get<TokenNameDefinition[]>('tokenNameDefinitions') || [];
        fragmentDefinitions = config.get<FragmentDefinition[]>('fragmentDefinitions') || [];
      }
    }
    debugLog(`[KAHUA] Final config: Found ${tokenDefinitions.length} token definitions, ${fragmentDefinitions.length} fragment definitions`);

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

    // Find the fragment definitions we need and validate them
    const selectedFragmentDefs = FragmentValidationService.getValidatedFragments(
      fragmentDefinitions, 
      fragmentIds, 
      documentType
    );

    // Collect all unique token references from selected fragments
    const allTokenReferences = FragmentValidationService.collectTokenReferences(selectedFragmentDefs);

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

    // Identify selection tokens (tokens that require user selection from XML)
    // These are typically used for entity selection, but could be any selectable element
    const selectionTokens = tokenDefinitions
      .filter(def => allTokenReferences.has(def.id))
      .flatMap(def => {
        if (!def.tokenReadPaths) return [];
        return Object.entries(def.tokenReadPaths)
          .filter(([, readPath]) => readPath.type === 'selection')
          .map(([tokenName, readPath]) => ({
            name: tokenName,
            readPath: readPath as TokenReadPath,
            tokenDef: def
          }));
      });

    debugLog(`[DEBUG] Found ${selectionTokens.length} selection token(s):`, selectionTokens.map(t => t.name));

    // Prompt for selection tokens if source XML is available
    if (sourceXmlDocument && selectionTokens.length > 0) {
      for (const selectionToken of selectionTokens) {
        const attributeName = selectionToken.readPath.attribute || 'Name';
        const configuredPath = selectionToken.readPath.path;
        let options: Array<{ value: string; context: string }> = [];

        if (configuredPath) {
          options = extractSelectableValues(sourceXmlDocument, configuredPath, attributeName);
        }

        if (options.length > 0) {
          const picked = await showValueSelectionPick(selectionToken.name, options);
          if (picked) {
            extractedValues.set(selectionToken.name, picked);
          }
        } else {
          debugLog(`[DEBUG] No options available for ${selectionToken.name} in source XML document`);
        }
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

    // Add context comments for tokens that affect injection
    const hasAffectingTokens = tokenDefinitions.some(tokenDef => 
      tokenDef.tokenReadPaths && Object.values(tokenDef.tokenReadPaths).some(rp => rp.affectsInjection)
    );
    
    if (hasAffectingTokens) {
      templateLines.push('// ----------------------------------------------------------------');
      
      for (const tokenDef of tokenDefinitions) {
        if (!tokenDef.tokenReadPaths) continue;
        
        for (const [tokenName, readPath] of Object.entries(tokenDef.tokenReadPaths)) {
          if (readPath.affectsInjection) {
            const tokenValue = extractedValues.get(tokenName);
            const displayValue = tokenValue || `<Select ${tokenName}>`;
            const displayName = tokenName.charAt(0).toUpperCase() + tokenName.slice(1);
            templateLines.push(`// ${displayName} Context: ${displayValue}`);
            
            // Add special guidance for selection-type tokens
            if (readPath.type === 'selection') {
              templateLines.push(`// All template rows will target this ${tokenName}. Update this header if you change ${tokenName}s.`);
              templateLines.push(`// Smart injection will automatically use this ${tokenName} for path resolution.`);
            }
          }
        }
      }
      
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
          return extractedValues.has(token.name) ? extractedValues.get(token.name) : '';
        });
        templateLines.push(headerValues.join(','));
      }
    }

    // Add pre-filled data line for table tokens if any were extracted
    if (tableTokens.length > 0) {
      const hasExtractedTableValues = tableTokens.some(token => extractedValues.has(token.name));
      if (hasExtractedTableValues) {
        const tableValues = tableTokens.map(token => {
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

      // Store token values that affect injection (already collected in extractedValues)
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
    const selectionOptions: SelectionHandlingOptions = {
      targetType: target.type,
      targetUri: target.type === 'sourceFile' || target.type === 'currentFile' || target.type === 'selectFile'
        ? target.uri
        : undefined
    };
    return await handleSelectionInternal(fragmentIds, editor, progress, selectionOptions);
  });

  if (!generationResult) {
    return;
  }

  await finalizeGeneratedFragmentsWithTarget(editor, fragmentIds, generationResult, target);
}

/**
 * Infers fragment IDs from a template or snippet document by looking at the header comment
 */
function inferFragmentIdsFromDocument(document: vscode.TextDocument): string[] {
  debugLog(`[DEBUG] inferFragmentIdsFromDocument: Processing ${document.lineCount} lines from ${document.uri.fsPath}`);
  
  for (let i = 0; i < Math.min(10, document.lineCount); i++) {
    const text = document.lineAt(i).text.trim();
    debugLog(`[DEBUG] Line ${i}: "${text}"`);
    
    if (!text.startsWith('//')) {
      continue;
    }

    // Look for patterns like "// Kahua Template for attributes", "// Kahua Snippet for lookups", or "// Kahua Table for attributes"
    const match = text.match(/^\/\/\s*(?:kahua\s+)?(?:template|snippet|table)\s+for\s+(.+)$/i);
    if (match) {
      debugLog(`[DEBUG] Found match: "${match[0]}", captured: "${match[1]}"`);
      const fragmentsText = match[1].split(/[,&]/)[0].trim();
      debugLog(`[DEBUG] Extracted fragment: "${fragmentsText}"`);
      const result = [fragmentsText.toLowerCase()];
      debugLog(`[DEBUG] Returning fragment IDs: ${JSON.stringify(result)}`);
      return result;
    }
  }

  // No fragment pattern found - cannot reliably infer fragment type
  // Better to return empty and let user specify than to guess incorrectly
  debugLog('[DEBUG] No fragment IDs could be inferred from document headers');
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
  // Use freshly extracted tokens from generation, not cached ones
  const affectingTokens = generation.extractedTokens || injectionAffectingTokens.get(currentFileUri.toString());
  const derivedSourceUri = generation.sourceUri ? vscode.Uri.parse(generation.sourceUri) : undefined;

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
      await openGenerationReport(
        currentFileResults,
        target.uri,
        generation.generationDetails,
        generation.skippedRows,
        generation.generatedXml
      );
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
      await openGenerationReport(
        sourceFileResults,
        target.uri,
        generation.generationDetails,
        generation.skippedRows,
        generation.generatedXml
      );
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
      await openGenerationReport(
        selectFileResults,
        target.uri,
        generation.generationDetails,
        generation.skippedRows,
        generation.generatedXml
      );
      vscode.window.showInformationMessage(
        `Kahua: Generated fragments for ${fragmentIds.join(', ')} inserted into ${fileName}`
      );
      setGenerationStatus(`Inserted fragments into ${fileName}`, true);
      break;
    }

    case 'newEditor': {
      const report = buildGenerationReport(
        [],
        derivedSourceUri ? getWorkspaceRelativePath(derivedSourceUri) : '(Not Applicable)',
        generation.generationDetails,
        generation.skippedRows,
        generation.generatedXml
      );
      const newDocument = await vscode.workspace.openTextDocument({
        content: report,
        language: 'plaintext'
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
      if (generation.generationDetails) {
        await openGenerationReport([], derivedSourceUri, generation.generationDetails, generation.skippedRows, generation.generatedXml);
      }
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

  // Determine output target for old-style generation
  const currentDocument = editor.document;
  const target = await showOutputTargetQuickPick(currentDocument);

  if (!target) {
    vscode.window.showInformationMessage('Kahua: Generation cancelled');
    setGenerationStatus('Generation cancelled', true);
    return;
  }

  await finalizeGeneratedFragmentsWithTarget(editor, fragmentIds, generationResult, target);
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

type SelectionHandlingOptions = {
    targetType?: OutputTarget['type'];
    targetUri?: vscode.Uri;
};

async function handleSelectionInternal(
    fragmentIds: string[],
    editor: vscode.TextEditor,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    options?: SelectionHandlingOptions
): Promise<GeneratedFragmentResult | undefined> {
    try {
        progress.report({ message: "Loading configuration...", increment: 10 });
        
        // Check if we're operating on a template/snippet document
        const isTemplate = isTemplateDocument(editor.document);
        const isSnippet = isSnippetDocument(editor.document);
        const isTemplateOrSnippet = isTemplate || isSnippet;
        
        // If we're in a template/snippet, determine which XML file should supply token context
        let sourceXmlDocumentForTokens: vscode.TextDocument | undefined;
        if (isTemplateOrSnippet) {
            const targetType = options?.targetType;
            if (targetType === 'newEditor' || targetType === 'clipboard') {
                debugLog('[DEBUG] handleSelectionInternal: Skipping token context lookup (output does not inject)');
            } else if (options?.targetUri) {
                try {
                    sourceXmlDocumentForTokens = await vscode.workspace.openTextDocument(options.targetUri);
                    debugLog(`[DEBUG] handleSelectionInternal: Using target URI for token reading: ${options.targetUri.fsPath}`);
                } catch (openError) {
                    debugLog('[DEBUG] handleSelectionInternal: Failed to open target URI, falling back to remembered source', openError);
                    sourceXmlDocumentForTokens = await getXmlDocumentForContext(editor.document);
                }
            } else {
                sourceXmlDocumentForTokens = await getXmlDocumentForContext(editor.document);
            }
            debugLog(`[DEBUG] handleSelectionInternal: Token context document: ${sourceXmlDocumentForTokens?.uri.fsPath ?? 'none'}`);
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

        const selectedFragmentDefs = FragmentValidationService.getValidatedFragments(
            fragmentDefinitions, 
            fragmentIds, 
            documentType
        );
        setGenerationStatus('Validating template data…', false);

        const allTokenReferences = FragmentValidationService.collectTokenReferences(selectedFragmentDefs);

        const { headerTokens, tableTokens, tokenDefaults } = mergeTokenDefinitions(
            tokenDefinitions,
            Array.from(allTokenReferences)
        );

        // Extract values from source XML if processing a template/snippet with source XML context
        const xmlExtractedValues = new Map<string, string>();
        if (sourceXmlDocumentForTokens) {
            const referencedTokenDefs = tokenDefinitions.filter(def =>
                allTokenReferences.has(def.id)
            );
            
            debugLog(`[DEBUG] handleSelectionInternal: Found ${referencedTokenDefs.length} referenced token definitions for XML extraction`);

            for (const tokenDef of referencedTokenDefs) {
                if (tokenDef.tokenReadPaths) {
                    try {
                        debugLog(`[DEBUG] handleSelectionInternal: Reading XML tokens for ${tokenDef.id}`);
                        const values = await readTokenValuesFromXml(sourceXmlDocumentForTokens, tokenDef.tokenReadPaths);
                        debugLog(`[DEBUG] handleSelectionInternal: Got ${values.size} values from XML`);
                        values.forEach((value, key) => xmlExtractedValues.set(key, value));
                    } catch (tokenError) {
                        debugLog(`[DEBUG] handleSelectionInternal: Error reading XML tokens for ${tokenDef.id}:`, tokenError instanceof Error ? tokenError.message : String(tokenError));
                    }
                }
            }
            
            debugLog(`[DEBUG] handleSelectionInternal: Total XML extracted values: ${xmlExtractedValues.size}`);
        }

        const groups = splitIntoGroups(documentText);
        if (groups.length === 0) {
            throw new Error('Current document contains no valid token data. Remove comments/whitespace-only lines or add token rows.');
        }

        setGenerationStatus(`Detected ${groups.length} group${groups.length === 1 ? '' : 's'} - preparing…`, false);
        const allWarnings: string[] = [];
        const outputSections: string[] = [];
        const reportSections: string[] = [];
        const skippedRowMessages: string[] = [];

        for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
            const group = groups[groupIndex];
            setGenerationStatus(`Processing group ${groupIndex + 1} of ${groups.length}…`, false);
            const headerLine = headerTokens.length > 0 && group.length > 0 ? group[0] : undefined;
            const dataLines = headerLine ? group.slice(1) : group;

            if (tableTokens.length > 0 && dataLines.length === 0) {
                throw new Error(`Group ${groupIndex + 1}: No data lines found. Header tokens were processed but no table data rows remain.`);
            }

            const groupTokenData: RowTokenData[] = [];

            progress.report({ message: `Processing group ${groupIndex + 1} rows...`, increment: 30 });
            const groupRenderStart = Date.now();

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

                    const missingTokens = [
                        ...collectMissingRequiredTokens(headerTokens, tokenName => rawTokenValues[tokenName]),
                        ...collectMissingRequiredTokens(tableTokens, tokenName => rawTokenValues[tokenName])
                    ];
                    if (missingTokens.length > 0) {
                        const absoluteRow = batchStart + lineIndex + 1;
                        skippedRowMessages.push(`Group ${groupIndex + 1}, row ${absoluteRow}: ${missingTokens.join(', ')}`);
                        continue;
                    }

                    groupTokenData.push({ clean: { ...cleanTokenValues }, raw: { ...rawTokenValues } });
                }

                if (batchEnd < totalRows) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }
            logDuration(`Group ${groupIndex + 1}: fragment rendering`, groupRenderStart);

            if (groupTokenData.length === 0) {
                continue;
            }

            const allTokenNames = [...headerTokens.map(t => t.name), ...tableTokens.map(t => t.name)];
            debugLog(`[KAHUA] Formatting group ${groupIndex + 1}: preparing token table for ${groupTokenData.length} rows`);
            const tokenTableStart = Date.now();
            const tokenTable = createFormattedTokenTable(allTokenNames, groupTokenData, tokenDefaults, groupIndex + 1);
            logDuration(`Group ${groupIndex + 1}: token table`, tokenTableStart);

            reportSections.push(tokenTable);
            const renderResult = renderFragmentSectionsFromRows(
                selectedFragmentDefs,
                groupTokenData,
                sourceXmlDocumentForTokens || editor.document,
                applyFormatting,
                xmlIndentSize,
                suppressWarnings
            );
            allWarnings.push(...renderResult.warnings);
            if (renderResult.sections.length > 0) {
                outputSections.push(renderResult.sections.join('\n\n'));
            }
        }

        setGenerationStatus('Formatting generated XML…', false);
        if (allWarnings.length > 0 && !suppressWarnings) {
            vscode.window.showWarningMessage(`Kahua: ${allWarnings.join('; ')}`);
        }

        let generatedXml = outputSections.join('\n\n');

        if (applyFormatting) {
            generatedXml = formatXml(generatedXml, xmlIndentSize);
        }

        // Extract tokens that affect injection from multiple sources
        const extractedTokens = new Map<string, string>();
        
        // First, include tokens extracted from XML source (e.g., appname, entity selection)
        for (const tokenDef of tokenDefinitions) {
            if (tokenDef.tokenReadPaths) {
                for (const [tokenName, readPath] of Object.entries(tokenDef.tokenReadPaths)) {
                    if (readPath.affectsInjection && xmlExtractedValues.has(tokenName)) {
                        extractedTokens.set(tokenName, xmlExtractedValues.get(tokenName)!);
                        debugLog(`[DEBUG] Extracted injection token from XML: ${tokenName}=${xmlExtractedValues.get(tokenName)}`);
                    }
                }
            }
        }
        
        // Extract tokens from template comments (e.g., "// Entity Context: RFI")
        const templateTokens = extractTokensFromTemplateComments(editor.document);
        debugLog('[KAHUA] Template tokens extracted:', templateTokens);
        for (const [tokenName, tokenValue] of templateTokens) {
            // Only cache tokens that affect injection
            const affectsInjection = tokenDefinitions.some(tokenDef => 
                tokenDef.tokenReadPaths?.[tokenName]?.affectsInjection
            );
            debugLog(`[KAHUA] Token ${tokenName}=${tokenValue}, affectsInjection: ${affectsInjection}`);
            if (affectsInjection) {
                extractedTokens.set(tokenName, tokenValue);
                debugLog(`[KAHUA] Extracted injection token from template comments: ${tokenName}=${tokenValue}`);
            }
        }
        
        // Then, include tokens from template header data (but don't override template comment values)
        if (groups.length > 0 && groups[0].length > 0 && headerTokens.length > 0) {
            const firstGroup = groups[0];
            const headerLine = firstGroup[0];
            const { rawTokenValues } = getTokenValues(headerTokens, tableTokens, headerLine, '');
            
            // Only include tokens that affect injection and aren't already set from template comments
            for (const tokenDef of tokenDefinitions) {
                if (tokenDef.tokenReadPaths) {
                    for (const [tokenName, readPath] of Object.entries(tokenDef.tokenReadPaths)) {
                        if (readPath.affectsInjection && rawTokenValues[tokenName] && !extractedTokens.has(tokenName)) {
                            // Use raw value and trim it, but don't apply case transformations
                            const rawValue = rawTokenValues[tokenName].trim();
                            extractedTokens.set(tokenName, rawValue);
                            debugLog(`[DEBUG] Extracted injection token from template header (raw): ${tokenName}=${rawValue}`);
                        }
                    }
                }
            }
        }

        const generationDetails = reportSections.join('\n\n').trim();

        return {
            generatedXml,
            fragmentDefinition: selectedFragmentDefs[0],
            tokenDefinitions,
            extractedTokens,
            generationDetails: generationDetails.length > 0 ? generationDetails : undefined,
            skippedRows: skippedRowMessages.length > 0 ? skippedRowMessages : undefined,
            sourceUri: sourceXmlDocumentForTokens?.uri?.toString() ?? editor.document.uri.toString()
        };

    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error occurred';
        vscode.window.showErrorMessage(`Kahua Attribute Generator: ${message}`);
        setGenerationStatus('Generation failed', true);
        return undefined;
    }
}

// REMOVED: Old finalizeGeneratedFragments function - replaced by unified version

// Old function body removed


export function parseXmlStringForTests(xml: string): SaxElement | null {
  return XmlParsingService.parseXmlDocumentInternal(xml);
}

export async function __testGenerateXmlFromRequest(
  request: GenerationRequest
): Promise<GenerationResult | undefined> {
  const progressStub = {
    report: () => {}
  } as vscode.Progress<{ message?: string; increment?: number }>;
  return generateXmlFromRequest(request, progressStub);
}

export function __testStoreInjectionTokensForDocument(
  documentUri: vscode.Uri,
  tokenDefinitions: TokenNameDefinition[],
  extractedTokens: Map<string, string>
): Map<string, string> | undefined {
  storeInjectionTokensForDocument(documentUri, tokenDefinitions, extractedTokens);
  const stored = injectionAffectingTokens.get(documentUri.toString());
  injectionAffectingTokens.delete(documentUri.toString());
  return stored;
}

