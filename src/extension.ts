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
 * Cleans a token value by removing internal whitespace and special characters
 * for use in XML attributes and identifiers
 */
function cleanTokenValue(value: string): string {
  if (!value) return value;
  
  // Remove internal whitespace and common special characters
  // Keep alphanumeric characters, hyphens, and underscores
  return value.replace(/\s+/g, '').replace(/[^a-zA-Z0-9\-_]/g, '');
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
 * Supports: ==, !=, <=, >=, <>, in, not in, ternary operator
 */
function evaluateExpression(expression: string): boolean {
  // Remove extra whitespace
  expression = expression.trim();
  
  // Handle ternary operator (condition ? value : fallback)
  const ternaryMatch = expression.match(/^(.+?)\s*\?\s*(.+?)\s*:\s*(.+)$/);
  if (ternaryMatch) {
    const [, condition, trueValue, falseValue] = ternaryMatch;
    const conditionResult = evaluateExpression(condition);
    return conditionResult;
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
 * Processes conditional blocks in template strings
 */
function processConditionalTemplate(template: string, tokenValues: Record<string, string>, suppressWarnings: boolean): { result: string; warnings: string[] } {
  const warnings: string[] = [];
  let result = template;
  
  // Process conditional expressions by finding balanced braces
  let pos = 0;
  while (pos < result.length) {
    const startPos = result.indexOf('{$', pos);
    if (startPos === -1) break;
    
    // Check if this looks like a conditional (contains ? and :)
    let braceCount = 0;
    let endPos = startPos;
    let foundQuestion = false;
    let foundColon = false;
    
    for (let i = startPos; i < result.length; i++) {
      const char = result[i];
      if (char === '{') braceCount++;
      else if (char === '}') braceCount--;
      else if (char === '?' && braceCount === 1) foundQuestion = true;
      else if (char === ':' && braceCount === 1 && foundQuestion) foundColon = true;
      
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
      
      // Extract the true and false values from the ternary
      const ternaryMatch = expression.match(/^(.+?)\s*\?\s*'(.*?)'\s*:\s*'(.*?)'$/);
      if (ternaryMatch) {
        const [, conditionPart, trueValue, falseValue] = ternaryMatch;
        // Evaluate only the condition part, not the entire ternary expression
        const conditionResult = evaluateConditional(conditionPart, tokenValues);
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
 * Processes template fragments to handle conditional keys
 */
function processFragmentTemplates(
  fragmentTemplates: Record<string, string>, 
  tokenValues: Record<string, string>, 
  suppressWarnings: boolean
): { processedFragments: Record<string, string>; warnings: string[] } {
  const processedFragments: Record<string, string> = {};
  const allWarnings: string[] = [];
  
  for (const [key, template] of Object.entries(fragmentTemplates)) {
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
  
  return { processedFragments, warnings: allWarnings };
}

/**
 * This function is called when your extension is activated. Your extension is activated
 * the very first time the command is executed.
 */
export function activate(context: vscode.ExtensionContext) {
  // Register commands for both extension and supplement modes. Each will call
  // the shared handler with the appropriate mode string.
  // This allows the extension to be used from the command palette or context menu.
  // The commands are registered with the context so they can be disposed of when the extension is deactivated.
  // The commands are also added to the context menu for easy access.
  // The context variable 'kahua.showInContextMenu' is set to true to enable
  // the context menu items when the editor has focus and a selection is made.
  vscode.commands.executeCommand('setContext', 'kahua.showInContextMenu', true);
  
  context.subscriptions.push(
    vscode.commands.registerCommand('kahua.createExtensionAttributes', () => handleSelection('extension')),
    vscode.commands.registerCommand('kahua.createSupplementAttributes', () => handleSelection('supplement')),
    vscode.commands.registerCommand('kahua.insertTokenTemplate', () => insertTokenTemplate()),
    vscode.commands.registerCommand('kahua.insertTokenSnippet', () => insertTokenSnippet())
  );
}

/**
 * This function is called when your extension is deactivated. Nothing to clean up
 * at the moment, but the function is required by VS Code's API.
 */
export function deactivate() {
  /* no‑op */
}

/**
 * Handles the logic of reading the current selection and generating XML snippets
 * based on the provided mode. Validates configuration and selection, then generates
 * XML using configurable tokens and fragments.
 *
 * @param mode Determines which prefix configuration key to use: "extension" or "supplement".
 */
async function handleSelection(mode: 'extension' | 'supplement'): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('No active editor found');
    return;
  }

  try {
    // Validate configuration
    const config = vscode.workspace.getConfiguration();
    
    // Get warning suppression setting
    const suppressWarnings = config.get<boolean>('kahua.suppressInvalidConditionWarnings') || false;
    
    // Get and validate token names
    const tokenNamesConfig = config.get<string>('kahua.tokenNames');
    if (!tokenNamesConfig || typeof tokenNamesConfig !== 'string' || tokenNamesConfig.trim() === '') {
      throw new Error('kahua.tokenNames is not defined or is empty. Please configure token names in your settings.');
    }
    
    // Parse token names and their default values
    const tokenConfigs = tokenNamesConfig.split(',').map(t => t.trim()).filter(Boolean);
    if (tokenConfigs.length === 0) {
      throw new Error('kahua.tokenNames contains no valid token names. Please provide comma-separated token names.');
    }
    
    // Parse tokens with optional default values (format: "tokenName" or "tokenName:defaultValue")
    const tokenNames: string[] = [];
    const tokenDefaults: Record<string, string> = {};
    
    for (const tokenConfig of tokenConfigs) {
      const [tokenName, defaultValue] = tokenConfig.split(':', 2);
      if (!tokenName) {
        throw new Error(`Invalid token configuration: "${tokenConfig}". Token names cannot be empty.`);
      }
      tokenNames.push(tokenName);
      tokenDefaults[tokenName] = defaultValue || ''; // Use provided default or empty string
    }
    
    // Get and validate fragments
    const fragmentTemplates = config.get<Record<string, string>>('kahua.fragments');
    if (!fragmentTemplates || typeof fragmentTemplates !== 'object' || Object.keys(fragmentTemplates).length === 0) {
      throw new Error('kahua.fragments is not defined or is empty. Please configure fragment templates in your settings.');
    }
    
    // Validate that fragments contain valid templates
    for (const [key, template] of Object.entries(fragmentTemplates)) {
      if (!template || typeof template !== 'string') {
        throw new Error(`Fragment '${key}' has an invalid template. All fragments must be non-empty strings.`);
      }
    }

    // Validate selection
    const selection = editor.document.getText(editor.selection);
    if (!selection || selection.trim() === '') {
      throw new Error('No text selected. Please select one or more lines of text to generate attributes.');
    }
    
    const lines = selection.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) {
      throw new Error('Selected text contains no valid lines. Please select text with content.');
    }

    // Process each line
    const expanded: Record<string, string[]> = {};
    const allTokenData: Array<Record<string, string>> = [];
    const allWarnings: string[] = [];
    
    for (const line of lines) {
      const rawParts = line.split(','); // Keep original whitespace, allow empty parts
      
      // Build token values for this line
      const rawTokenValues: Record<string, string> = {};
      const cleanTokenValues: Record<string, string> = {};
      
      for (let i = 0; i < tokenNames.length; i++) {
        const tokenName = tokenNames[i];
        const rawPart = rawParts[i] || '';
        const trimmedPart = rawPart.trim();
        
        rawTokenValues[tokenName] = rawPart || tokenDefaults[tokenName];
        cleanTokenValues[tokenName] = cleanTokenValue(trimmedPart || tokenDefaults[tokenName]);
      }
      
      // Store token data for the table
      allTokenData.push({ ...cleanTokenValues });

      // Process fragment templates with conditional support
      const { processedFragments, warnings: fragmentWarnings } = processFragmentTemplates(fragmentTemplates, cleanTokenValues, suppressWarnings);
      allWarnings.push(...fragmentWarnings);

      // Apply token replacement for all processed fragments
      for (const [key, template] of Object.entries(processedFragments)) {
        // First process conditional expressions in the template
        const { result: conditionalProcessed, warnings: conditionalWarnings } = processConditionalTemplate(template, cleanTokenValues, suppressWarnings);
        allWarnings.push(...conditionalWarnings);
        
        let rendered = conditionalProcessed;
        
        // Handle whitespace-controlled token replacement with $ prefix
        for (const [tokenName, cleanValue] of Object.entries(cleanTokenValues)) {
          const rawValue = rawTokenValues[tokenName];
          
          // Replace {$token:friendly} - preserves original whitespace/formatting
          rendered = rendered.replaceAll(`{$${tokenName}:friendly}`, rawValue);
          
          // Replace {$token:internal} - uses cleaned value (internal whitespace removed)
          rendered = rendered.replaceAll(`{$${tokenName}:internal}`, cleanValue);
          
          // Replace {$token} - default behavior (uses cleaned value)
          rendered = rendered.replaceAll(`{$${tokenName}}`, cleanValue);
        }
        
        (expanded[key] ??= []).push(rendered);
      }
    }

    // Show warnings if any and not suppressed
    if (allWarnings.length > 0 && !suppressWarnings) {
      vscode.window.showWarningMessage(`Kahua: ${allWarnings.join('; ')}`);
    }

    // Create token table
    const tokenTable = createTokenTable(tokenNames, allTokenData, tokenDefaults);

    // Join each category of snippets together
    const fragmentsXml = Object.entries(expanded)
      .map(([key, lines]: [string, string[]]) =>
        `<!-- ${key} -->\n${lines.join('\n')}`
      ).join('\n\n');
    
    const generatedXml = `${tokenTable}\n\n${fragmentsXml}`;
      
    // Get the output target setting
    const outputTarget = config.get<string>('kahua.outputTarget') || 'newEditor';

    if (outputTarget === 'newEditor') {
      // Open in new editor window
      const newDocument = await vscode.workspace.openTextDocument({
        content: generatedXml,
        language: 'xml'
      });

      await vscode.window.showTextDocument(newDocument, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false
      });

      vscode.window.showInformationMessage(`Kahua: Generated ${mode} attributes in new editor window`);
    } else {
      // Copy to clipboard
      await vscode.env.clipboard.writeText(generatedXml);
      vscode.window.showInformationMessage(`Kahua: Generated ${mode} attributes copied to clipboard`);
    }

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    vscode.window.showErrorMessage(`Kahua Attribute Generator: ${message}`);
  }
}

/**
 * Creates a table showing token names and their values from the processed lines
 */
function createTokenTable(tokenNames: string[], tokenData: Array<Record<string, string>>, tokenDefaults: Record<string, string>): string {
  if (tokenData.length === 0) {
    return '<!-- No token data -->';
  }
  
  const header = `| Token | Default | ${tokenData.map((_, i) => `Line ${i + 1}`).join(' | ')} |`;
  const separator = `|${'-'.repeat(7)}|${'-'.repeat(9)}|${tokenData.map(() => '-'.repeat(8)).join('|')}|`;
  
  const rows = tokenNames.map(tokenName => {
    const defaultValue = tokenDefaults[tokenName] || '';
    const values = tokenData.map(data => data[tokenName] || '');
    return `| ${tokenName} | ${defaultValue} | ${values.join(' | ')} |`;
  });
  
  return `<!-- Token Configuration and Values Table -->\n${header}\n${separator}\n${rows.join('\n')}`;
}

/**
 * Inserts a token template as a comment showing the expected token order
 */
async function insertTokenTemplate(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('No active editor found');
    return;
  }

  try {
    // Get current token configuration
    const config = vscode.workspace.getConfiguration();
    const tokenNamesConfig = config.get<string>('kahua.tokenNames');
    
    if (!tokenNamesConfig || typeof tokenNamesConfig !== 'string' || tokenNamesConfig.trim() === '') {
      throw new Error('kahua.tokenNames is not configured. Please configure token names in your settings.');
    }

    // Parse token names and show defaults where available
    const tokenConfigs = tokenNamesConfig.split(',').map(t => t.trim()).filter(Boolean);
    const tokenDisplays = tokenConfigs.map(tokenConfig => {
      const [tokenName, defaultValue] = tokenConfig.split(':', 2);
      return defaultValue ? `${tokenName}:${defaultValue}` : tokenName;
    });

    const templateText = `// Template: ${tokenDisplays.join(', ')}\n`;
    
    // Insert at cursor position
    const position = editor.selection.active;
    await editor.edit(editBuilder => {
      editBuilder.insert(position, templateText);
    });

    vscode.window.showInformationMessage('Kahua: Token template inserted');

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    vscode.window.showErrorMessage(`Kahua Token Template: ${message}`);
  }
}

/**
 * Inserts a token snippet with tab stops for each token position
 */
async function insertTokenSnippet(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('No active editor found');
    return;
  }

  try {
    // Get current token configuration
    const config = vscode.workspace.getConfiguration();
    const tokenNamesConfig = config.get<string>('kahua.tokenNames');
    
    if (!tokenNamesConfig || typeof tokenNamesConfig !== 'string' || tokenNamesConfig.trim() === '') {
      throw new Error('kahua.tokenNames is not configured. Please configure token names in your settings.');
    }

    // Parse token names and create snippet with tab stops that allow typeover of commas
    const tokenConfigs = tokenNamesConfig.split(',').map(t => t.trim()).filter(Boolean);
    const snippetParts: string[] = [];
    let tabStopIndex = 1;
    
    for (let i = 0; i < tokenConfigs.length; i++) {
      const [tokenName, defaultValue] = tokenConfigs[i].split(':', 2);
      const placeholder = defaultValue || tokenName;
      
      // Add the token placeholder
      snippetParts.push(`\${${tabStopIndex}:${placeholder}}`);
      tabStopIndex++;
      
      // Add comma as a typeover placeholder (except for the last token)
      if (i < tokenConfigs.length - 1) {
        snippetParts.push(`\${${tabStopIndex}:, }`);
        tabStopIndex++;
      }
    }

    const snippetText = snippetParts.join('');
    const snippet = new vscode.SnippetString(snippetText);
    
    // Insert snippet at cursor position
    await editor.insertSnippet(snippet);

    vscode.window.showInformationMessage('Kahua: Token snippet inserted');

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error occurred';
    vscode.window.showErrorMessage(`Kahua Token Snippet: ${message}`);
  }
}