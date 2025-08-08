import * as vscode from 'vscode';

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
    
    for (const line of lines) {
      const rawParts = line.split(','); // Keep original whitespace, allow empty parts
      const trimmedParts = rawParts.map(p => p.trim()); // Trimmed for processing
      
      // Build token values for this line
      const tokenValues: Record<string, string> = {};
      const rawTokenValues: Record<string, string> = {};
      
      for (let i = 0; i < tokenNames.length; i++) {
        const tokenName = tokenNames[i];
        // Use input value, or fall back to configured default, or empty string
        const inputValue = trimmedParts[i];
        const rawInputValue = rawParts[i];
        
        tokenValues[tokenName] = inputValue || tokenDefaults[tokenName];
        rawTokenValues[tokenName] = rawInputValue || tokenDefaults[tokenName];
      }
      
      // Store token data for the table
      allTokenData.push({ ...tokenValues });

      // Apply token replacement for all configured tokens
      for (const [key, template] of Object.entries(fragmentTemplates)) {
        let rendered = template;
        
        // Handle whitespace-controlled token replacement
        for (const [tokenName, tokenValue] of Object.entries(tokenValues)) {
          const rawValue = rawTokenValues[tokenName];
          
          // Replace {token:friendly} - preserves original whitespace/formatting
          rendered = rendered.replaceAll(`{${tokenName}:friendly}`, rawValue);
          
          // Replace {token:internal} - uses processed/trimmed value (explicit)
          rendered = rendered.replaceAll(`{${tokenName}:internal}`, tokenValue);
          
          // Replace {token} - default behavior (uses processed/trimmed value)
          rendered = rendered.replaceAll(`{${tokenName}}`, tokenValue);
        }
        
        (expanded[key] ??= []).push(rendered);
      }
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