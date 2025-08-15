import * as vscode from 'vscode';

/**
 * Represents a conditional expression result
 */
interface ConditionalResult {
  condition: boolean;
  hasValidTokens: boolean;
  invalidTokens: string[];
}

/**
 * Configuration interfaces for the new system
 */
interface TokenNameDefinition {
  id: string;
  name: string;
  type: 'header' | 'table';
  tokens: string;
}

interface FragmentDefinition {
  id: string;
  name: string;
  type?: 'grouped' | 'table'; // Default is 'grouped'
  tokenReferences: string[];
  fragments: Record<string, string | Record<string, string>>;
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
 * Converts a token value to PascalCase by removing spaces and special characters
 * and capitalizing the first letter of each word
 */
function toPascalCase(value: string): string {
  if (!value) return value;
  
  // Split on word boundaries (spaces, punctuation, etc.) and filter out empty strings
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(word => word.length > 0)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('');
}

/**
 * Converts a token value to TitleCase following standard capitalization rules
 */
function toTitleCase(value: string): string {
  if (!value) return value;
  
  // Words that should remain lowercase (articles, short prepositions, conjunctions)
  const lowercaseWords = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'yet', 'so',
    'in', 'on', 'at', 'by', 'for', 'of', 'to', 'up', 'as'
  ]);
  
  // Split into words while preserving spaces
  const words = value.toLowerCase().split(/(\s+)/);
  
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
function formatXml(xml: string, indentSize: number = 2): string {
  if (!xml || xml.trim() === '') return xml;
  
  const lines = xml.split(/\r?\n/);
  const formatted: string[] = [];
  const indent = ' '.repeat(indentSize);
  
  // For the extension's output, we mainly want to:
  // 1. Preserve comments and table data as-is
  // 2. Indent nested XML elements
  // 3. Keep self-closing tags at the base level
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue; // Skip empty lines
    
    // Handle comments and non-XML content - no indentation changes
    if (trimmed.startsWith('<!--') || !trimmed.startsWith('<')) {
      formatted.push(trimmed);
      continue;
    }
    
    // For XML tags, determine indentation based on content
    if (trimmed.startsWith('<DataTag') && !trimmed.endsWith('/>')) {
      // DataTag opening - no indent for the tag itself
      formatted.push(trimmed);
    } else if (trimmed.startsWith('</DataTag>')) {
      // DataTag closing - no indent
      formatted.push(trimmed);
    } else if (trimmed.startsWith('<Key />') || trimmed.startsWith('<Value ')) {
      // Nested elements within DataTag or LookupList - indent
      formatted.push(indent + trimmed);
    } else if (trimmed.startsWith('<LookupList') && !trimmed.endsWith('/>')) {
      // LookupList opening - no indent
      formatted.push(trimmed);
    } else if (trimmed.startsWith('</LookupList>')) {
      // LookupList closing - no indent  
      formatted.push(trimmed);
    } else {
      // All other XML elements (Attribute, Label, Field, etc.) - no indent
      formatted.push(trimmed);
    }
  }
  
  return formatted.join('\n');
}

/**
 * Formats a collection of XML fragments with section headers and proper indentation
 */
function formatFragmentCollection(fragments: { [key: string]: string[] }, indentSize: number = 2): string {
  const sections: string[] = [];
  
  for (const [sectionName, fragmentList] of Object.entries(fragments)) {
    if (fragmentList.length === 0) continue;
    
    // Add section header comment
    sections.push(`<!-- ${sectionName} -->`);
    
    // Format each fragment in the section
    const formattedFragments = fragmentList.map(fragment => formatXml(fragment, indentSize));
    sections.push(formattedFragments.join('\n'));
  }
  
  return sections.join('\n\n');
}

/**
 * Applies transformation to a token value based on the transformation type
 */
function applyTokenTransformation(value: string, transformation: string): string {
  if (!value) return value;
  
  switch (transformation.toLowerCase()) {
    case 'friendly':
      return escapeXml(toTitleCase(value)); // Apply TitleCase and XML escape
    case 'internal':
      return toPascalCase(value); // Convert to PascalCase (no XML escaping needed for identifiers)
    case 'upper':
      return escapeXml(value.toUpperCase()); // Convert to uppercase and XML escape
    case 'lower':
      return escapeXml(value.toLowerCase()); // Convert to lowercase and XML escape
    case 'slug':
      return toPascalCase(value) + '_'; // Convert to PascalCase and append underscore
    case 'raw':
      return value; // Leave exactly as user typed it (no processing)
    default:
      return toPascalCase(value); // Default: PascalCase (no XML escaping for identifiers)
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
    const { condition, trueValue, falseValue } = ternaryResult;
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
  
  // Handle comparison operators
  const comparisonMatch = expression.match(/^"([^"]*?)"\s*(==|!=|<=|>=|<>)\s*"([^"]*?)"$/);
  if (comparisonMatch) {
    const [, left, operator, right] = comparisonMatch;
    
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
  if (expression === '""' || expression === 'false' || expression === '0') {
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
    const char = expression[i];
    const nextChar = expression[i + 1];
    
    if (char === ')') parenCount++;
    else if (char === '(') parenCount--;
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
  
  // Process conditional expressions by finding balanced braces
  let pos = 0;
  while (pos < result.length) {
    const startPos = result.indexOf('{$', pos);
    if (startPos === -1) break;
    
    // Find the matching closing brace, respecting nesting
    let braceCount = 0;
    let endPos = startPos;
    let foundQuestion = false;
    let foundColon = false;
    let inQuotes = false;
    let quoteChar = '';
    
    for (let i = startPos; i < result.length; i++) {
      const char = result[i];
      const prevChar = i > 0 ? result[i - 1] : '';
      
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
      
      if (!inQuotes) {
        if (char === '{') braceCount++;
        else if (char === '}') braceCount--;
        else if (char === '?' && braceCount === 1) foundQuestion = true;
        else if (char === ':' && braceCount === 1 && foundQuestion) foundColon = true;
      }
      // Note: We intentionally ignore $() tokens within strings during conditional parsing
      // These will be processed later by processStringInterpolation()
      
      if (braceCount === 0) {
        endPos = i;
        break;
      }
    }
    
    if (foundQuestion && foundColon) {
      // This is a conditional expression
      const fullMatch = result.substring(startPos, endPos + 1);
      const expression = fullMatch.slice(2, -1); // Remove {$ and }
      
      const evalResult = evaluateConditional(expression, tokenValues);
      
      if (!evalResult.hasValidTokens && !suppressWarnings) {
        warnings.push(`Invalid tokens in conditional expression "${expression}": ${evalResult.invalidTokens.join(', ')}`);
      }
      
      // Use the improved ternary parsing to extract values
      const ternaryResult = findTernaryOperator(expression);
      if (ternaryResult) {
        const conditionResult = evaluateConditional(ternaryResult.condition, tokenValues);
        
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
        
        const replacementValue = conditionResult.condition ? trueValue : falseValue;
        result = result.substring(0, startPos) + replacementValue + result.substring(endPos + 1);
        pos = startPos + replacementValue.length;
      } else {
        // Fallback: remove the conditional block if malformed
        result = result.substring(0, startPos) + result.substring(endPos + 1);
        pos = startPos;
      }
    } else {
      pos = startPos + 2; // Move past this {$ and continue looking
    }
  }
  
  return { result, warnings };
}

/**
 * Processes template fragments to handle conditional keys and nested structures
 */
function processFragmentTemplates(
  fragmentTemplates: Record<string, string | Record<string, string>>, 
  tokenValues: Record<string, string>, 
  suppressWarnings: boolean
): { processedFragments: Record<string, string>; warnings: string[] } {
  const processedFragments: Record<string, string> = {};
  const allWarnings: string[] = [];
  
  for (const [key, template] of Object.entries(fragmentTemplates)) {
    if (typeof template === 'object') {
      // Handle nested structure (like body: { Attributes: "...", Labels: "..." })
      for (const [subKey, subTemplate] of Object.entries(template)) {
        const fullKey = `${key} - ${subKey}`;
        processedFragments[fullKey] = subTemplate;
      }
    } else {
      // Handle flat structure
      // Check if the key itself contains a conditional
      const keyConditionalMatch = key.match(/^\{\$([^}]+\s*\?\s*[^}]+\s*:\s*[^}]+)\}(.*)$/);
      
      if (keyConditionalMatch) {
        const [, expression, keyRemainder] = keyConditionalMatch;
        const evalResult = evaluateConditional(expression, tokenValues);
        
        if (!evalResult.hasValidTokens && !suppressWarnings) {
          allWarnings.push(`Invalid tokens in conditional key "${key}": ${evalResult.invalidTokens.join(', ')}`);
        }
        
        // Only include this fragment if the condition is true
        if (evalResult.condition) {
          // Extract the actual key name from the ternary expression
          const ternaryMatch = expression.match(/^(.+?)\s*\?\s*'([^']*?)'\s*:\s*'([^']*?)'$/);
          if (ternaryMatch) {
            const [, , trueValue] = ternaryMatch;
            const actualKey = trueValue + keyRemainder;
            processedFragments[actualKey] = template;
          }
        }
        // If condition is false, this fragment is omitted entirely
      } else {
        // Regular key without conditional
        processedFragments[key] = template;
      }
    }
  }
  
  return { processedFragments, warnings: allWarnings };
}

/**
 * This function is called when your extension is activated.
 */
export function activate(context: vscode.ExtensionContext) {
  // Set up context menu visibility
  vscode.commands.executeCommand('setContext', 'kahua.showInContextMenu', true);
  
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
  
  // Register custom generation commands
  context.subscriptions.push(
    vscode.commands.registerCommand('kahua.generateCustom', async () => {
      const config = vscode.workspace.getConfiguration();
      const menuOptions = config.get<MenuOption[]>('kahua.menuOptions') || [];
      
      if (menuOptions.length === 0) {
        vscode.window.showErrorMessage('No menu options configured. Please configure kahua.menuOptions in your settings.');
        return;
      }
      
      const pick = await vscode.window.showQuickPick(
        menuOptions.map(option => ({
          label: option.name,
          fragments: option.fragments
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
  
  // Phase 1: Process conditional expressions
  const { result: conditionalProcessed, warnings: conditionalWarnings } = processConditionalTemplate(
    template, 
    cleanTokenValues, 
    suppressWarnings
  );
  warnings.push(...conditionalWarnings);
  
  // Phase 2: Process PowerShell-style string interpolations $(token)
  let rendered = processStringInterpolation(conditionalProcessed, cleanTokenValues, rawTokenValues);
  
  // Phase 3: Handle remaining {$token} transformation-controlled token replacement
  for (const [tokenName, cleanValue] of Object.entries(cleanTokenValues)) {
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
  
  return { result: rendered, warnings };
}

/**
 * Shows quickpick for selecting custom fragments
 */
async function selectCustomFragments(placeholder: string): Promise<{ label: string; fragments: string[] } | undefined> {
  const config = vscode.workspace.getConfiguration();
  const menuOptions = config.get<MenuOption[]>('kahua.menuOptions') || [];
  
  if (menuOptions.length === 0) {
    vscode.window.showErrorMessage('No menu options configured. Please configure kahua.menuOptions in your settings.');
    return undefined;
  }
  
  return await vscode.window.showQuickPick(
    menuOptions.map(option => ({
      label: option.name,
      fragments: option.fragments
    })),
    { 
      placeHolder: placeholder,
      title: 'Kahua Custom Fragment Selector'
    }
  );
}

/**
 * Generates and inserts a snippet for the specified fragment types
 */
async function generateSnippetForFragments(fragmentIds: string[]): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('No active editor found');
    return;
  }

  try {
    const config = vscode.workspace.getConfiguration();
    const tokenDefinitions = config.get<TokenNameDefinition[]>('kahua.tokenNameDefinitions') || [];
    const fragmentDefinitions = config.get<FragmentDefinition[]>('kahua.fragmentDefinitions') || [];
    
    if (tokenDefinitions.length === 0) {
      throw new Error('No token name definitions found. Please configure kahua.tokenNameDefinitions in your settings.');
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

    // Separate header and table token definitions
    const snippetLines: string[] = [];
    let tabStopIndex = 1;
    let numberOfRows = 0; // Track total rows for message
    
    // Create header line if there are header tokens
    if (headerTokens.length > 0) {
      const headerParts: string[] = [];
      
      for (let i = 0; i < headerTokens.length; i++) {
        const token = headerTokens[i];
        const placeholder = token.defaultValue || token.name;
        
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
      const config = vscode.workspace.getConfiguration();
      const defaultTableRows = config.get<number>('kahua.defaultSnippetTableRows') || 0;
      
      numberOfRows = defaultTableRows;
      
      // If default is 0, use current behavior (single row)
      // If default > 0, prompt user for row count with default value
      if (defaultTableRows > 0) {
        // Get the maximum value from configuration schema (fallback to 100 if not found)
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
          const placeholder = token.defaultValue || token.name;
          
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
    const snippet = new vscode.SnippetString(snippetText);
    
    // Insert snippet at cursor position
    await editor.insertSnippet(snippet);

    const rowText = numberOfRows === 0 
      ? 'header only' 
      : numberOfRows === 1 
        ? '1 table row' 
        : `${numberOfRows} table rows`;
    vscode.window.showInformationMessage(`Kahua: Token snippet inserted for ${fragmentIds.join(', ')} with ${rowText}`);

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    vscode.window.showErrorMessage(`Kahua Token Snippet: ${message}`);
  }
}

/**
 * Generates and inserts a template for the specified fragment types
 */
async function generateTemplateForFragments(fragmentIds: string[]): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('No active editor found');
    return;
  }

  try {
    const config = vscode.workspace.getConfiguration();
    const tokenDefinitions = config.get<TokenNameDefinition[]>('kahua.tokenNameDefinitions') || [];
    const fragmentDefinitions = config.get<FragmentDefinition[]>('kahua.fragmentDefinitions') || [];
    
    if (tokenDefinitions.length === 0) {
      throw new Error('No token name definitions found. Please configure kahua.tokenNameDefinitions in your settings.');
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

    // Build template text showing all token definitions
    const templateLines: string[] = [];
    templateLines.push(`// Token Template for ${fragmentIds.join(', ')}:`);
    
    if (headerTokens.length > 0) {
      const headerTokenDisplays = headerTokens.map(token => 
        token.defaultValue ? `${token.name}:${token.defaultValue}` : token.name
      );
      templateLines.push(`// Header tokens: ${headerTokenDisplays.join(', ')}`);
    }
    
    if (tableTokens.length > 0) {
      const tableTokenDisplays = tableTokens.map(token => 
        token.defaultValue ? `${token.name}:${token.defaultValue}` : token.name
      );
      templateLines.push(`// Table tokens: ${tableTokenDisplays.join(', ')}`);
    }
    
    templateLines.push('//');
    templateLines.push('// Usage: First line contains header tokens, subsequent lines contain table tokens');
    templateLines.push('');

    const templateText = templateLines.join('\n');
    
    // Insert at cursor position
    const position = editor.selection.active;
    await editor.edit(editBuilder => {
      editBuilder.insert(position, templateText);
    });

    vscode.window.showInformationMessage(`Kahua: Token template inserted for ${fragmentIds.join(', ')}`);

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
    const config = vscode.workspace.getConfiguration();
    const suppressWarnings = config.get<boolean>('kahua.suppressInvalidConditionWarnings') || false;
    
    // Get configuration arrays
    const tokenDefinitions = config.get<TokenNameDefinition[]>('kahua.tokenNameDefinitions') || [];
    const fragmentDefinitions = config.get<FragmentDefinition[]>('kahua.fragmentDefinitions') || [];
    
    if (tokenDefinitions.length === 0) {
      throw new Error('No token name definitions found. Please configure kahua.tokenNameDefinitions in your settings.');
    }
    
    if (fragmentDefinitions.length === 0) {
      throw new Error('No fragment definitions found. Please configure kahua.fragmentDefinitions in your settings.');
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
      const structuredFragments: { [fragmentName: string]: { header?: string; body: string[]; footer?: string } } = {};
      const groupedFragments: { [fragmentName: string]: { [fragmentKey: string]: string[] } } = {};
      
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

        // Process each selected fragment definition
        for (const fragmentDef of selectedFragmentDefs) {
          const { processedFragments, warnings: fragmentWarnings } = processFragmentTemplates(
            fragmentDef.fragments, 
            cleanTokenValues, 
            suppressWarnings
          );
          allWarnings.push(...fragmentWarnings);

          const fragmentType = fragmentDef.type || 'grouped'; // Default to 'grouped'
          
          if (fragmentType === 'table') {
            // Table type uses header/body/footer structure
            if (!(fragmentDef.name in structuredFragments)) {
              structuredFragments[fragmentDef.name] = { body: [] };
            }
            
            // Process header (only once per group)
            if (!structuredFragments[fragmentDef.name].header && processedFragments.header) {
              const rendered = renderTemplate(processedFragments.header, cleanTokenValues, rawTokenValues, suppressWarnings);
              structuredFragments[fragmentDef.name].header = rendered.result;
              allWarnings.push(...rendered.warnings);
            }
            
            // Process body (for each row) - handle both single body and nested fragments
            if (processedFragments.body) {
              const rendered = renderTemplate(processedFragments.body, cleanTokenValues, rawTokenValues, suppressWarnings);
              structuredFragments[fragmentDef.name].body.push(rendered.result);
              allWarnings.push(...rendered.warnings);
            }
            
            // Process nested body fragments (like "body - Attributes", "body - Labels")
            for (const [key, template] of Object.entries(processedFragments)) {
              if (key.startsWith('body - ')) {
                const rendered = renderTemplate(template, cleanTokenValues, rawTokenValues, suppressWarnings);
                structuredFragments[fragmentDef.name].body.push(rendered.result);
                allWarnings.push(...rendered.warnings);
              }
            }
            
            // Process footer (only once per group, but we'll set it each time - last one wins)
            if (processedFragments.footer) {
              const rendered = renderTemplate(processedFragments.footer, cleanTokenValues, rawTokenValues, suppressWarnings);
              structuredFragments[fragmentDef.name].footer = rendered.result;
              allWarnings.push(...rendered.warnings);
            }
          } else {
            // Grouped type uses original fragment grouping behavior
            if (!(fragmentDef.name in groupedFragments)) {
              groupedFragments[fragmentDef.name] = {};
            }
            
            // Process each fragment template and group by fragment key
            for (const [key, template] of Object.entries(processedFragments)) {
              const rendered = renderTemplate(template, cleanTokenValues, rawTokenValues, suppressWarnings);
              allWarnings.push(...rendered.warnings);
              
              // Group fragments by key (e.g., "attribute", "label", etc.)
              if (!groupedFragments[fragmentDef.name][key]) {
                groupedFragments[fragmentDef.name][key] = [];
              }
              groupedFragments[fragmentDef.name][key].push(rendered.result);
            }
          }
        }
      }

      // Create token table for this group
      const allTokenNames = [...headerTokens.map(t => t.name), ...tableTokens.map(t => t.name)];
      const tokenTable = createFormattedTokenTable(allTokenNames, groupTokenData, tokenDefaults, groupIndex + 1);
      
      // Build output for this group
      const groupOutputSections: string[] = [tokenTable];
      
      // Add structured fragments (table type)
      for (const [fragmentName, fragments] of Object.entries(structuredFragments)) {
        const parts: string[] = [];
        if (fragments.header) parts.push(fragments.header);
        parts.push(...fragments.body);
        if (fragments.footer) parts.push(fragments.footer);
        
        groupOutputSections.push(`\n<!-- ${fragmentName} -->\n\n${parts.join('\n')}`);
      }
      
      // Add grouped fragments (grouped type)
      for (const [fragmentName, fragmentGroups] of Object.entries(groupedFragments)) {
        for (const [fragmentKey, fragments] of Object.entries(fragmentGroups)) {
          //groupOutputSections.push(`\n<!-- ${fragmentName} - ${fragmentKey} -->\n\n${fragments.join('\n')}`);
          groupOutputSections.push(`\n<!-- ${fragmentKey} -->\n\n${fragments.join('\n')}`);
        }
      }
      
      
      outputSections.push(groupOutputSections.join('\n\n'));
    }

    // Show warnings if any and not suppressed
    if (allWarnings.length > 0 && !suppressWarnings) {
      vscode.window.showWarningMessage(`Kahua: ${allWarnings.join('; ')}`);
    }

    let generatedXml = outputSections.join('\n\n');
    
    // Apply XML formatting if enabled
    const formatXmlOutput = config.get<boolean>('kahua.formatXmlOutput');
    const xmlIndentSize = config.get<number>('kahua.xmlIndentSize') || 2;
    
    if (formatXmlOutput !== false) { // Default to true if not configured
      generatedXml = formatXml(generatedXml, xmlIndentSize);
    }
      
    // Get the output target setting
    const outputTarget = config.get<string>('kahua.outputTarget') || 'newEditor';

    if (outputTarget === 'newEditor') {
      const newDocument = await vscode.workspace.openTextDocument({
        content: generatedXml,
        language: 'xml'
      });

      await vscode.window.showTextDocument(newDocument, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false
      });

      vscode.window.showInformationMessage(`Kahua: Generated fragments for ${fragmentIds.join(', ')} in new editor window`);
    } else {
      await vscode.env.clipboard.writeText(generatedXml);
      vscode.window.showInformationMessage(`Kahua: Generated fragments for ${fragmentIds.join(', ')} copied to clipboard`);
    }

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    vscode.window.showErrorMessage(`Kahua Attribute Generator: ${message}`);
  }
}


