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
 * based on the provided mode. When invoked, it reads each selected line,
 * sanitizes it to form a valid attribute name, and then creates attribute,
 * label, datatag, field and field definition fragments according to user
 * configurable templates. The result is placed on the clipboard and a
 * notification is shown.
 *
 * @param mode Determines which prefix configuration key to use: "extension" or "supplement".
 */
async function handleSelection(mode: 'extension' | 'supplement'): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  // Fetch the base prefix for the current mode from configuration. Defaults defined in package.json.
  const modePrefix: string = vscode.workspace.getConfiguration().get<string>(`kahua.defaultPrefix.${mode}`) || '';

  // Grab the currently selected text and split it into trimmed, nonempty lines.
  const selection = editor.document.getText(editor.selection);
  const lines = selection.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // Read the entire document to allow fallback prefix extraction from the first EntityDef when needed.
  const documentText = editor.document.getText();

  // Attempt to find the first <EntityDef Name="..."> in the document. Used when only an attribute name is provided.
  const firstEntityName = (() => {
    const match = documentText.match(/<\s*EntityDef[^>]*\bName\s*=\s*"([^"<>]+)"/);
    return match ? match[1] : '';
  })();

  // Helper to fetch a template from configuration with fallback to a default.
  const format = (key: string, fallback: string): string => {
    return vscode.workspace.getConfiguration().get<string>(`kahua.tokens.${key}`) || fallback;
  };

  // Get configurable token names from settings
  const tokenNamesConfig = vscode.workspace.getConfiguration().get<string>('kahua.tokenNames') || 'name,prefix,type,label';
  const tokenNames = tokenNamesConfig.split(',').map(t => t.trim()).filter(Boolean);

  // For each line produce a set of XML snippet parts.
  const fragmentTemplates = vscode.workspace.getConfiguration().get<Record<string, string>>('kahua.fragments') || {};

  const expanded: Record<string, string[]> = {};
  for (const line of lines) {
    const rawParts = line.split(',').filter(p => p !== ''); // Keep original whitespace
    const parts = rawParts.map(p => p.trim()).filter(Boolean); // Trimmed for processing
    if (!parts.length) continue;

    // Build token values dynamically based on configured token names
    const tokenValues: Record<string, string> = {};
    
    // Handle each configured token
    for (let i = 0; i < tokenNames.length; i++) {
      const tokenName = tokenNames[i];
      let value = '';
      
      if (tokenName === 'name') {
        // For 'name' token, store the sanitized version but we'll handle raw in replacement
        value = parts[0] ? parts[0].replace(/[^A-Za-z0-9]/g, '') : '';
      } else if (tokenName === 'label') {
        // Label uses the original unsanitized first part
        value = parts[0] || '';
      } else if (tokenName === 'prefix') {
        // Prefix logic: use provided value, fall back to document EntityDef, then mode prefix
        value = parts[i] || firstEntityName || modePrefix;
      } else if (tokenName === 'type') {
        // Type defaults to 'Text'
        value = parts[i] || 'Text';
      } else {
        // For any other token, use the corresponding part or empty string
        value = parts[i] || '';
      }
      
      tokenValues[tokenName] = value;
    }
    
    // Store raw parts for friendly mode access
    const rawTokenValues: Record<string, string> = {};
    for (let i = 0; i < tokenNames.length; i++) {
      const tokenName = tokenNames[i];
      if (tokenName === 'name' || tokenName === 'label') {
        // For name and label, preserve the original first part
        rawTokenValues[tokenName] = rawParts[0] || '';
      } else if (tokenName === 'prefix') {
        // For prefix, use raw input or fallbacks
        rawTokenValues[tokenName] = rawParts[i] || firstEntityName || modePrefix;
      } else {
        // For other tokens, use raw input
        rawTokenValues[tokenName] = rawParts[i] || '';
      }
    }

    // Apply token replacement for all configured tokens
    for (const [key, template] of Object.entries(fragmentTemplates)) {
      let rendered = template;
      
      // Handle both simple {token} and whitespace-controlled {token:mode} syntax
      for (const [tokenName, tokenValue] of Object.entries(tokenValues)) {
        const rawValue = rawTokenValues[tokenName] || '';
        
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


  // Join each category of snippets together so they're grouped in the output.
  const generatedXml = Object.entries(expanded)
    .map(([key, lines]: [string, string[]]) =>
      `<!-- ${key} -->\n${lines.join('\n')}`
    ).join('\n\n');
    
  // Get the output target setting
  const outputTarget = vscode.workspace.getConfiguration().get<string>('kahua.outputTarget') || 'clipboard';

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
    // Copy to clipboard (existing behavior)
    await vscode.env.clipboard.writeText(generatedXml);
    vscode.window.showInformationMessage(`Kahua: Generated ${mode} attributes copied to clipboard`);
  }
}