import * as vscode from "vscode";
import { Disposable, Webview, WebviewPanel, window, Uri, ViewColumn } from "vscode";
import { getUri } from "../utilities/getUri";
import { getNonce } from "../utilities/getNonce";

/**
 * Interface for table data passed between extension and webview
 */
export interface TableData {
  headers: string[];
  headerFields?: Array<{name: string, value: string, label: string, required?: boolean}>;
  rows: string[][];
  fragmentName: string;
  fragmentIds?: string[];
  sourceFile?: string;
  sourceUri?: string; // Full URI string
  documentType?: string;
  selectedFragmentDefs?: any[];
  allTokenReferences?: string[];
  headerTokens?: any[];
  tableTokens?: any[];
  tokenDefinitions?: any[];
}

/**
 * This class manages the state and behavior of Table Generation webview panels.
 */
export class TableGenerationPanel {
  public static currentPanel: TableGenerationPanel | undefined;
  private readonly _panel: WebviewPanel;
  private _disposables: Disposable[] = [];
  private _tableData: TableData;

  /**
   * The TableGenerationPanel class private constructor (called only from the render method).
   */
  private constructor(panel: WebviewPanel, extensionUri: Uri, tableData: TableData) {
    this._panel = panel;
    this._tableData = tableData;

    // Set an event listener to listen for when the panel is disposed
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Set up message handling from webview
    this._setWebviewMessageListener(this._panel.webview);

    // Set the HTML content for the webview panel
    this._panel.webview.html = this._getWebviewContent(this._panel.webview, extensionUri);
  }

  /**
   * Renders the current webview panel if it exists otherwise a new webview panel
   * will be created and displayed.
   */
  public static render(extensionUri: Uri, tableData: TableData) {
    if (TableGenerationPanel.currentPanel) {
      // If the webview panel already exists, update it with new data
      TableGenerationPanel.currentPanel._tableData = tableData;
      TableGenerationPanel.currentPanel._panel.webview.html = 
        TableGenerationPanel.currentPanel._getWebviewContent(TableGenerationPanel.currentPanel._panel.webview, extensionUri);
      TableGenerationPanel.currentPanel._panel.reveal(ViewColumn.One);
    } else {
      // If a webview panel does not already exist create and show a new one
      const panel = window.createWebviewPanel(
        "showTableForGeneration",
        "Table for Generation",
        ViewColumn.One,
        {
          enableScripts: true,
          localResourceRoots: [Uri.joinPath(extensionUri, "out")],
        }
      );

      TableGenerationPanel.currentPanel = new TableGenerationPanel(panel, extensionUri, tableData);
    }
  }

  /**
   * Cleans up and disposes of webview resources when the webview panel is closed.
   */
  public dispose() {
    TableGenerationPanel.currentPanel = undefined;
    this._panel.dispose();

    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  /**
   * Sets up message listener for webview communication
   */
  private _setWebviewMessageListener(webview: Webview) {
    webview.onDidReceiveMessage(
      (message: any) => {
        const command = message.command;
        switch (command) {
          case "tableDataChanged":
            // Handle table data changes
            this._tableData.rows = message.data;
            break;
          case "headerFieldChanged":
            // Handle header field changes
            if (this._tableData.headerFields) {
              const field = this._tableData.headerFields.find(f => f.name === message.fieldName);
              if (field) {
                field.value = message.value;
              }
            }
            break;
          case "generateNewEditor":
            this._handleGeneration('newEditor', message.data);
            break;
          case "generateSourceFile":
            this._handleGeneration('sourceFile', message.data);
            break;
          case "generateFile":
            this._handleGeneration('file', message.data);
            break;
        }
      },
      undefined,
      this._disposables
    );
  }

  /**
   * Handle XML generation request from webview
   */
  private _handleGeneration(
    type: 'newEditor' | 'sourceFile' | 'file', 
    data: { headerFields: Record<string, string>; tableRows: string[][] }
  ) {
    // Send message back to extension to handle generation
    vscode.commands.executeCommand(
      'kahua.handleTableGeneration',
      {
        type,
        fragmentIds: this._tableData.fragmentIds,
        headerFields: data.headerFields,
        tableRows: data.tableRows,
        selectedFragmentDefs: this._tableData.selectedFragmentDefs,
        allTokenReferences: this._tableData.allTokenReferences,
        headerTokens: this._tableData.headerTokens,
        tableTokens: this._tableData.tableTokens,
        tokenDefinitions: this._tableData.tokenDefinitions,
        documentType: this._tableData.documentType,
        sourceFile: this._tableData.sourceFile, // Pass source file back to extension
        sourceUri: this._tableData.sourceUri // Pass full URI back to extension
      }
    );
  }

  /**
   * Defines and returns the HTML that should be rendered within the webview panel.
   */
  private _getWebviewContent(webview: Webview, extensionUri: Uri) {
    const webviewUri = getUri(webview, extensionUri, ["out", "tableWebview.js"]);
    const nonce = getNonce();

    // Create header info section HTML
    // Build header columns display with values
    const headerColumnsDisplay = this._tableData.headerFields && this._tableData.headerFields.length > 0
      ? this._tableData.headerFields.map(field => {
          const label = field.label || field.name;
          const requiredText = field.required ? ' (Required)' : '';
          return `${label}${requiredText}:${field.value}`;
        }).join(', ')
      : 'None';
    
    // Build table columns display with defaults indicated
    const tableColumnsDisplay = this._tableData.headers.map((header) => {
      const token = this._tableData.tableTokens?.find(t => t.name === header);
      const label = token ? token.name : header;
      const requiredText = token?.required ? ' (Required)' : '';
      const defaultValue = token?.defaultValue;
      return defaultValue ? `${label}${requiredText}:${defaultValue}*` : `${label}${requiredText}`;
    }).join(', ');

    const hasRequiredFields =
      (this._tableData.headerFields?.some(field => field.required) ?? false) ||
      (this._tableData.tableTokens?.some(token => token.required) ?? false);

    const headerInfo = `
      <div class="header-info">
        <h2>Table for Generation: ${this._tableData.fragmentName}</h2>
        ${this._tableData.sourceFile ? `<p><strong>Source File:</strong> ${this._tableData.sourceFile}</p>` : ''}
        ${this._tableData.documentType ? `<p><strong>Document Type:</strong> ${this._tableData.documentType}</p>` : ''}
        <p><strong>Header Columns:</strong> ${headerColumnsDisplay}</p>
        <p><strong>Table Columns:</strong> ${tableColumnsDisplay}</p>
        ${this._tableData.tableTokens?.some(t => t.defaultValue) ? '<p><em>* = Default value will be applied to new rows</em></p>' : ''}
        ${hasRequiredFields ? '<p><span class="required-indicator" title="Required">*</span> Required field</p>' : ''}
      </div>
    `;

    // Create header fields section HTML
    const headerFieldsSection = this._tableData.headerFields && this._tableData.headerFields.length > 0 ? `
      <div class="header-fields">
        <h3>Header Values</h3>
        <div class="header-fields-grid">
          ${this._tableData.headerFields.map(field => `
            <div class="header-field">
              <label for="header-${field.name}">${field.label}${field.required ? '<span class="required-indicator" title="Required">*</span>' : ''}:</label>
              <input type="text" id="header-${field.name}" class="header-input" 
                     data-field="${field.name}" value="${field.value}" />
            </div>
          `).join('')}
        </div>
      </div>
    ` : '';

    return /*html*/ `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
          <title>Table for Generation</title>
          <style>
            body {
              font-family: var(--vscode-font-family);
              font-size: var(--vscode-font-size);
              color: var(--vscode-foreground);
              background-color: var(--vscode-editor-background);
              padding: 16px;
            }
            .header-info {
              background-color: var(--vscode-textBlockQuote-background);
              border-left: 4px solid var(--vscode-textBlockQuote-border);
              padding: 10px 12px;
              margin-bottom: 12px;
            }
            .header-info p {
              margin: 2px 0;
            }
            .header-fields {
              background-color: var(--vscode-input-background);
              border: 1px solid var(--vscode-input-border);
              border-radius: 4px;
              padding: 10px 12px;
              margin-bottom: 12px;
            }
            .header-fields h3 {
              margin-top: 0;
              margin-bottom: 10px;
              color: var(--vscode-foreground);
            }
            .header-fields-grid {
              display: grid;
              gap: 10px;
              grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            }
            .header-field {
              display: flex;
              flex-direction: column;
            }
            .header-field label {
              font-weight: bold;
              margin-bottom: 4px;
              color: var(--vscode-foreground);
            }
            .header-input {
              background-color: var(--vscode-input-background);
              border: 1px solid var(--vscode-input-border);
              color: var(--vscode-input-foreground);
              padding: 6px 8px;
              border-radius: 2px;
              font-family: inherit;
              font-size: inherit;
            }
            .header-input:focus {
              outline: 1px solid var(--vscode-focusBorder);
              border-color: var(--vscode-focusBorder);
            }
            .table-container {
              border: 1px solid var(--vscode-panel-border);
              border-radius: 4px;
              overflow: auto;
              max-height: 60vh;
            }
            table {
              width: 100%;
              border-collapse: collapse;
              background-color: var(--vscode-editor-background);
            }
            th, td {
              border: 1px solid var(--vscode-panel-border);
              padding: 8px;
              text-align: left;
              min-width: 120px;
            }
            th {
              background-color: var(--vscode-tab-inactiveBackground);
              font-weight: bold;
              position: sticky;
              top: 0;
              z-index: 1;
            }
            td {
              background-color: var(--vscode-editor-background);
            }
            .row-checkbox {
              width: 20px;
              margin: 0;
            }
            .editable {
              background: transparent;
              border: none;
              width: 100%;
              font-family: inherit;
              font-size: inherit;
              color: var(--vscode-foreground);
              padding: 4px;
            }
            .editable:focus {
              background-color: var(--vscode-input-background);
              color: var(--vscode-input-foreground);
              outline: 1px solid var(--vscode-focusBorder);
              border: 1px solid var(--vscode-focusBorder);
            }
            .controls {
              margin: 12px 0;
            }
            .generation-buttons {
              margin: 12px 0;
              padding-top: 10px;
              border-top: 1px solid var(--vscode-panel-border);
            }
            .btn {
              background-color: var(--vscode-button-background);
              color: var(--vscode-button-foreground);
              border: none;
              padding: 8px 16px;
              margin-right: 10px;
              cursor: pointer;
              border-radius: 2px;
            }
            .btn:hover {
              background-color: var(--vscode-button-hoverBackground);
            }
            .btn-secondary {
              background-color: var(--vscode-button-secondaryBackground);
              color: var(--vscode-button-secondaryForeground);
            }
            .btn-secondary:hover {
              background-color: var(--vscode-button-secondaryHoverBackground);
            }
            .required-indicator {
              color: var(--vscode-editorWarning-foreground, #d16969);
              margin-left: 4px;
              font-weight: bold;
            }
          </style>
        </head>
        <body>
          ${headerInfo}
          
          <div class="generation-buttons">
            <button id="generateNewEditorBtn" class="btn">Generate into New Editor</button>
            <button id="generateSourceFileBtn" class="btn">Generate into Source File</button>
            <button id="generateFileBtn" class="btn">Generate into File</button>
          </div>
          
          ${headerFieldsSection}
          
          <div class="controls">
            <button id="addRowBtn" class="btn">Add Row</button>
            <button id="deleteRowsBtn" class="btn btn-secondary">Delete Selected Rows</button>
          </div>

          <div class="table-container">
            <table id="dataTable">
              <thead>
                <tr>
                  <th><input type="checkbox" id="selectAll" class="row-checkbox"></th>
                  ${this._tableData.headers.map(header => {
                    const token = this._tableData.tableTokens?.find(t => t.name === header);
                    const indicator = token?.required ? '<span class="required-indicator" title="Required">*</span>' : '';
                    return `<th>${header}${indicator}</th>`;
                  }).join('')}
                </tr>
              </thead>
              <tbody id="tableBody">
                ${this._generateTableRows()}
              </tbody>
            </table>
          </div>

          <script nonce="${nonce}">
            // Pass table defaults to the webview - create a map by column name
            window.tableDefaultsByName = ${JSON.stringify(
              Object.fromEntries(
                this._tableData.tableTokens?.map(t => [t.name, t.defaultValue || '']) || []
              )
            )};
            window.tableHeaders = ${JSON.stringify(this._tableData.headers || [])};
          </script>
          <script nonce="${nonce}" src="${webviewUri}"></script>
        </body>
      </html>
    `;
  }

  /**
   * Generate HTML for table rows
   */
  private _generateTableRows(): string {
    if (this._tableData.rows.length === 0) {
      // Add one row with defaults applied
      const defaultRow = this._tableData.headers.map((header, index) => {
        const token = this._tableData.tableTokens?.find(t => t.name === header);
        return token?.defaultValue || '';
      });
      this._tableData.rows.push(defaultRow);
    }

    return this._tableData.rows.map((row, rowIndex) => `
      <tr data-row="${rowIndex}">
        <td><input type="checkbox" class="row-checkbox row-select"></td>
        ${row.map((cell, colIndex) => {
          // Apply defaults if cell is empty and we have a default
          const header = this._tableData.headers[colIndex];
          const token = this._tableData.tableTokens?.find(t => t.name === header);
          const value = cell || token?.defaultValue || '';
          
          return `
            <td>
              <input type="text" class="editable" 
                     data-row="${rowIndex}" 
                     data-col="${colIndex}" 
                     value="${value}" 
                     tabindex="${rowIndex * this._tableData.headers.length + colIndex + 1}">
            </td>
          `;
        }).join('')}
      </tr>
    `).join('');
  }
}
