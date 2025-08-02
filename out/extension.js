"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
/**
 * This function is called when your extension is activated. Your extension is activated
 * the very first time the command is executed.
 */
function activate(context) {
    // Register commands for both extension and supplement modes. Each will call
    // the shared handler with the appropriate mode string.
    // This allows the extension to be used from the command palette or context menu.
    // The commands are registered with the context so they can be disposed of when the extension is deactivated.
    // The commands are also added to the context menu for easy access.
    // The context variable 'kahua.showInContextMenu' is set to true to enable
    // the context menu items when the editor has focus and a selection is made.
    vscode.commands.executeCommand('setContext', 'kahua.showInContextMenu', true);
    context.subscriptions.push(vscode.commands.registerCommand('kahua.createExtensionAttributes', () => handleSelection('extension')), vscode.commands.registerCommand('kahua.createSupplementAttributes', () => handleSelection('supplement')));
}
/**
 * This function is called when your extension is deactivated. Nothing to clean up
 * at the moment, but the function is required by VS Code's API.
 */
function deactivate() {
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
async function handleSelection(mode) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }
    // Fetch the base prefix for the current mode from configuration. Defaults defined in package.json.
    const modePrefix = vscode.workspace.getConfiguration().get(`kahua.defaultPrefix.${mode}`) || '';
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
    const format = (key, fallback) => {
        return vscode.workspace.getConfiguration().get(`kahua.tokens.${key}`) || fallback;
    };
    // For each line produce a set of XML snippet parts.
    const fragmentTemplates = vscode.workspace.getConfiguration().get('kahua.fragments') || {};
    const expanded = {};
    for (const line of lines) {
        const parts = line.split(',').map(p => p.trim()).filter(Boolean);
        if (!parts.length)
            continue;
        const rawName = parts[0];
        const name = rawName.replace(/[^A-Za-z0-9]/g, '');
        const label = rawName;
        const prefix = parts[1] || firstEntityName || modePrefix;
        const type = parts[2] || 'Text';
        for (const [key, template] of Object.entries(fragmentTemplates)) {
            const rendered = template
                .replaceAll('{prefix}', prefix)
                .replaceAll('{name}', name)
                .replaceAll('{label}', label)
                .replaceAll('{type}', type);
            (expanded[key] ??= []).push(rendered);
        }
    }
    // Join each category of snippets together so they're grouped in the output.
    const result = Object.entries(expanded)
        .map(([key, lines]) => `<!-- ${key} -->\n${lines.join('\n')}`).join('\n\n');
    // Write the result to the clipboard. VS Code automatically handles asynchronous copy.
    await vscode.env.clipboard.writeText(result);
    vscode.window.showInformationMessage('Kahua XML generated to clipboard.');
}
//# sourceMappingURL=extension.js.map