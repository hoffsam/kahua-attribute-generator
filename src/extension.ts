import * as vscode from 'vscode';

/**
 * This function is called when your extension is activated. Your extension is activated
 * the very first time the command is executed.
 */
export function activate(context: vscode.ExtensionContext) {
  // Register commands for both extension and supplement modes. Each will call
  // the shared handler with the appropriate mode string.
  context.subscriptions.push(
    vscode.commands.registerCommand('kahua.createExtensionAttributes', () => handleSelection('extension')),
    vscode.commands.registerCommand('kahua.createSupplementAttributes', () => handleSelection('supplement'))
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

  // For each line produce a set of XML snippet parts.
  const snippets = lines.map(rawLine => {
    // Split the line by commas into up to three parts: AttributeName, Prefix/EntityName, DataType
    const parts = rawLine.split(',').map(p => p.trim()).filter(Boolean);
    if (parts.length === 0) {
      return null;
    }
    const rawName = parts[0];
    const name = rawName.replace(/[^A-Za-z0-9]/g, '');
    const label = rawName;
    let linePrefix: string;
    let dataType: string;
    if (parts.length >= 2) {
      // If a second part is provided, treat it as the prefix for this line.
      linePrefix = parts[1];
      dataType = parts.length >= 3 ? parts[2] : 'Text';
    } else {
      // Only attribute provided. Use the first EntityDef name as prefix if present, otherwise fall back to modePrefix.
      linePrefix = firstEntityName || modePrefix;
      dataType = 'Text';
    }
    // If linePrefix is still empty, fall back to modePrefix.
    if (!linePrefix) {
      linePrefix = modePrefix;
    }

    // Build up tokens by replacing placeholders with actual values.
    const labelToken = format('attributeLabelFormat', '[{prefix}_{name}Label]')
      .replace('{prefix}', linePrefix)
      .replace('{name}', name);
    const descToken = format('attributeDescriptionFormat', '[{prefix}_{name}Description]')
      .replace('{prefix}', linePrefix)
      .replace('{name}', name);
    const dataTagName = format('dataTagNameFormat', '{prefix}_{name}')
      .replace('{prefix}', linePrefix)
      .replace('{name}', name);
    const labelKey = format('labelKeyFormat', '{prefix}_{name}Label')
      .replace('{prefix}', linePrefix)
      .replace('{name}', name);
    const labelDescKey = `${linePrefix}_${name}Description`;
    const labelVal = format('labelValueFormat', '{label}').replace('{label}', label);
    // We reuse the same label for the description entry; users can override via settings if needed.
    const descVal = label;

    return {
      attribute: `<Attribute Name="${name}" Label="${labelToken}" Description="${descToken}" DataType="${dataType}" IsConfigurable="true" />`,
      // Two label entries: one for the main label and one for the description
      labels: [
        `<Label Key="${labelKey}">${labelVal}</Label>`,
        `<Label Key="${labelDescKey}">${descVal}</Label>`
      ],
      datatag: `<DataTag Name="${dataTagName}" Key="${dataTagName}" Label="${labelToken}" CultureLabelKey="${labelKey}" />`,
      field: `<Field Attribute="${name}" />`,
      fieldDef: `<FieldDef Name="${name}" Path="${name}" DataTag="${dataTagName}" Edit.Path="${name}" />`
    };
  }).filter(Boolean) as Array<{
    attribute: string;
    labels: string[];
    datatag: string;
    field: string;
    fieldDef: string;
  }>;

  // Join each category of snippets together so they're grouped in the output.
  const joined = {
    attributes: snippets.map(s => s.attribute).join('\n'),
    labels: snippets.flatMap(s => s.labels).join('\n'),
    dataTags: snippets.map(s => s.datatag).join('\n'),
    fields: snippets.map(s => s.field).join('\n'),
    fieldDefs: snippets.map(s => s.fieldDef).join('\n')
  };

  // Compose the final result with descriptive comments for each block.
  const result = `<!-- Attributes -->\n${joined.attributes}\n\n<!-- Labels -->\n${joined.labels}\n\n<!-- DataTags -->\n${joined.dataTags}\n\n<!-- DataStore Fields -->\n${joined.fields}\n\n<!-- FieldDefs -->\n${joined.fieldDefs}`;

  // Write the result to the clipboard. VS Code automatically handles asynchronous copy.
  await vscode.env.clipboard.writeText(result);
  vscode.window.showInformationMessage('Kahua XML generated to clipboard.');
}