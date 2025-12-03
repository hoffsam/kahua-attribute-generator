/**
 * Main script for the table generation webview
 */

// VS Code API
declare const acquireVsCodeApi: () => {
  postMessage(message: any): void;
  getState(): any;
  setState(state: any): void;
};

// Global data passed from extension will be available on window object

// Acquire the VS Code API
const vscode = acquireVsCodeApi();

window.addEventListener("load", main);

function main() {
  // Get DOM elements
  const table = document.getElementById("dataTable") as HTMLTableElement;
  const tableBody = document.getElementById("tableBody") as HTMLTableSectionElement;
  const addRowBtn = document.getElementById("addRowBtn") as HTMLButtonElement;
  const deleteRowsBtn = document.getElementById("deleteRowsBtn") as HTMLButtonElement;
  const generateNewEditorBtn = document.getElementById("generateNewEditorBtn") as HTMLButtonElement;
  const generateSourceFileBtn = document.getElementById("generateSourceFileBtn") as HTMLButtonElement;
  const generateFileBtn = document.getElementById("generateFileBtn") as HTMLButtonElement;
  const selectAllCheckbox = document.getElementById("selectAll") as HTMLInputElement;

  // Debug: Check if elements exist
  console.log('Button elements found:', {
    generateNewEditorBtn: !!generateNewEditorBtn,
    generateSourceFileBtn: !!generateSourceFileBtn, 
    generateFileBtn: !!generateFileBtn
  });

  // Set up event listeners
  setupTableInteraction();
  setupControlButtons();
  setupKeyboardNavigation();
  setupHeaderFields();
  focusFirstEditableCell();

  function setupTableInteraction() {
    // Handle cell editing
    tableBody.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement;
      if (target.classList.contains('editable')) {
        notifyDataChange();
      }
    });

    // Handle row selection
    tableBody.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;
      if (target.classList.contains('row-select')) {
        updateDeleteButtonState();
      }
    });

    // Select all functionality
    selectAllCheckbox.addEventListener('change', (e) => {
      const checkboxes = tableBody.querySelectorAll('.row-select') as NodeListOf<HTMLInputElement>;
      checkboxes.forEach(cb => {
        cb.checked = selectAllCheckbox.checked;
      });
      updateDeleteButtonState();
    });
  }

  function setupControlButtons() {
    addRowBtn.addEventListener('click', addRow);
    deleteRowsBtn.addEventListener('click', deleteSelectedRows);
    
    // Add null checks for generation buttons
    if (generateNewEditorBtn) {
      generateNewEditorBtn.addEventListener('click', () => {
        console.log('Generate New Editor button clicked!');
        generateXML('newEditor');
      });
    } else {
      console.error('generateNewEditorBtn not found');
    }
    
    if (generateSourceFileBtn) {
      generateSourceFileBtn.addEventListener('click', () => {
        console.log('Generate Source File button clicked!');
        generateXML('sourceFile');
      });
    } else {
      console.error('generateSourceFileBtn not found');
    }
    
    if (generateFileBtn) {
      generateFileBtn.addEventListener('click', () => {
        console.log('Generate File button clicked!');
        generateXML('file');
      });
    } else {
      console.error('generateFileBtn not found');
    }
  }

  function setupHeaderFields() {
    // Set up header field change listeners
    const headerInputs = document.querySelectorAll('.header-input') as NodeListOf<HTMLInputElement>;
    headerInputs.forEach(input => {
      input.addEventListener('input', (e) => {
        const target = e.target as HTMLInputElement;
        vscode.postMessage({
          command: 'headerFieldChanged',
          fieldName: target.dataset.field,
          value: target.value
        });
      });
    });
  }

  function setupKeyboardNavigation() {
    tableBody.addEventListener('keydown', (e) => {
      const target = e.target as HTMLInputElement;
      if (!target.classList.contains('editable')) return;

      const row = parseInt(target.dataset.row || '0');
      const col = parseInt(target.dataset.col || '0');

      switch (e.key) {
        case 'Tab':
          if (!e.shiftKey) {
            e.preventDefault();
            const isLastCell = isLastCellInTable(row, col);
            if (isLastCell) {
              addRow();
              // Focus will be set to new row's first cell
              setTimeout(() => {
                const newRowFirstCell = tableBody.querySelector(`input[data-row="${row + 1}"][data-col="0"]`) as HTMLInputElement;
                if (newRowFirstCell) {
                  newRowFirstCell.focus();
                }
              }, 50);
            } else {
              navigateToNextCell(row, col);
            }
          } else {
            e.preventDefault();
            navigateToPreviousCell(row, col);
          }
          break;
        case 'Enter':
          e.preventDefault();
          navigateToNextRow(row, col);
          break;
        case 'ArrowDown':
          e.preventDefault();
          navigateToNextRow(row, col);
          break;
        case 'ArrowUp':
          e.preventDefault();
          navigateToPreviousRow(row, col);
          break;
        case 'ArrowLeft':
          if (target.selectionStart === 0) {
            e.preventDefault();
            navigateToPreviousCell(row, col);
          }
          break;
        case 'ArrowRight':
          if (target.selectionStart === target.value.length) {
            e.preventDefault();
            navigateToNextCell(row, col);
          }
          break;
      }
    });

    // Handle paste operations for Excel/CSV data
    tableBody.addEventListener('paste', handlePaste);
  }

  function addRow() {
    const rowCount = tableBody.children.length;
    const colCount = getColumnCount();
    const newRow = document.createElement('tr');
    newRow.dataset.row = rowCount.toString();

    // Add checkbox cell
    const checkboxCell = document.createElement('td');
    checkboxCell.innerHTML = `<input type="checkbox" class="row-checkbox row-select">`;
    newRow.appendChild(checkboxCell);

    // Add data cells with defaults
    const headers = (window as any).tableHeaders || [];
    const defaultsByName = (window as any).tableDefaultsByName || {};
    
    for (let col = 0; col < colCount; col++) {
      const cell = document.createElement('td');
      const columnName = headers[col] || '';
      const defaultValue = defaultsByName[columnName] || '';
      
      cell.innerHTML = `
        <input type="text" class="editable" 
               data-row="${rowCount}" 
               data-col="${col}" 
               value="${defaultValue}" 
               tabindex="${rowCount * colCount + col + 1}">
      `;
      newRow.appendChild(cell);
    }

    tableBody.appendChild(newRow);
    notifyDataChange();
  }

  function deleteSelectedRows() {
    const checkboxes = tableBody.querySelectorAll('.row-select:checked') as NodeListOf<HTMLInputElement>;
    const rowsToDelete: HTMLTableRowElement[] = [];

    checkboxes.forEach(checkbox => {
      const row = checkbox.closest('tr') as HTMLTableRowElement;
      if (row) {
        rowsToDelete.push(row);
      }
    });

    rowsToDelete.forEach(row => {
      row.remove();
    });

    // Renumber remaining rows
    const remainingRows = tableBody.querySelectorAll('tr');
    remainingRows.forEach((row, index) => {
      row.dataset.row = index.toString();
      const inputs = row.querySelectorAll('.editable') as NodeListOf<HTMLInputElement>;
      inputs.forEach((input, colIndex) => {
        input.dataset.row = index.toString();
        input.dataset.col = colIndex.toString();
        input.tabIndex = index * getColumnCount() + colIndex + 1;
      });
    });

    updateDeleteButtonState();
    notifyDataChange();
  }

  function generateXML(type: 'newEditor' | 'sourceFile' | 'file') {
    console.log('generateXML called with type:', type);
    
    const tableRows = collectTableData();
    const headerFields = collectHeaderFields();
    
    console.log('Collected data:', { headerFields, tableRows });
    
    const command = type === 'newEditor' ? 'generateNewEditor' :
                   type === 'sourceFile' ? 'generateSourceFile' : 'generateFile';
    
    console.log('Sending message with command:', command);
    console.log('Full message object:', {
      command: command,
      data: {
        headerFields: headerFields,
        tableRows: tableRows
      }
    });
    
    try {
      vscode.postMessage({
        command: command,
        data: {
          headerFields: headerFields,
          tableRows: tableRows
        }
      });
      console.log('Message sent successfully');
    } catch (error) {
      console.error('Error sending message:', error);
    }
  }

  function collectHeaderFields(): Record<string, string> {
    const headerFields: Record<string, string> = {};
    const headerInputs = document.querySelectorAll('.header-input') as NodeListOf<HTMLInputElement>;
    
    headerInputs.forEach(input => {
      const fieldName = input.dataset.field;
      if (fieldName) {
        headerFields[fieldName] = input.value;
      }
    });
    
    return headerFields;
  }

  function navigateToNextCell(row: number, col: number) {
    const colCount = getColumnCount();
    let nextCol = col + 1;
    let nextRow = row;

    if (nextCol >= colCount) {
      nextCol = 0;
      nextRow++;
    }

    const nextCell = tableBody.querySelector(`input[data-row="${nextRow}"][data-col="${nextCol}"]`) as HTMLInputElement;
    if (nextCell) {
      nextCell.focus();
      nextCell.select();
    }
  }

  function navigateToPreviousCell(row: number, col: number) {
    let prevCol = col - 1;
    let prevRow = row;

    if (prevCol < 0) {
      prevCol = getColumnCount() - 1;
      prevRow--;
    }

    if (prevRow >= 0) {
      const prevCell = tableBody.querySelector(`input[data-row="${prevRow}"][data-col="${prevCol}"]`) as HTMLInputElement;
      if (prevCell) {
        prevCell.focus();
        prevCell.select();
      }
    }
  }

  function navigateToNextRow(row: number, col: number) {
    const nextCell = tableBody.querySelector(`input[data-row="${row + 1}"][data-col="${col}"]`) as HTMLInputElement;
    if (nextCell) {
      nextCell.focus();
      nextCell.select();
    } else {
      // If no next row exists, add one and navigate to it
      addRow();
      setTimeout(() => {
        const newCell = tableBody.querySelector(`input[data-row="${row + 1}"][data-col="${col}"]`) as HTMLInputElement;
        if (newCell) {
          newCell.focus();
          newCell.select();
        }
      }, 50);
    }
  }

  function navigateToPreviousRow(row: number, col: number) {
    if (row > 0) {
      const prevCell = tableBody.querySelector(`input[data-row="${row - 1}"][data-col="${col}"]`) as HTMLInputElement;
      if (prevCell) {
        prevCell.focus();
        prevCell.select();
      }
    }
  }

  function isLastCellInTable(row: number, col: number): boolean {
    const rowCount = tableBody.children.length;
    const colCount = getColumnCount();
    return row === rowCount - 1 && col === colCount - 1;
  }

  function getColumnCount(): number {
    const headerRow = table.querySelector('thead tr') as HTMLTableRowElement;
    return headerRow ? headerRow.children.length - 1 : 0; // Subtract 1 for checkbox column
  }

  function handlePaste(e: ClipboardEvent) {
    e.preventDefault();
    const clipboardData = e.clipboardData?.getData('text/plain');
    if (!clipboardData) return;

    const target = e.target as HTMLInputElement;
    if (!target.classList.contains('editable')) return;

    const startRow = parseInt(target.dataset.row || '0');
    const startCol = parseInt(target.dataset.col || '0');

    // Parse clipboard data (handle both tab and comma separated)
    const lines = clipboardData.trim().split('\n');
    const pasteData: string[][] = [];

    lines.forEach(line => {
      // Try tab-separated first, then comma-separated
      let cells = line.split('\t');
      if (cells.length === 1) {
        // If no tabs found, try comma separation
        cells = line.split(',').map(cell => cell.trim().replace(/^"(.*)"$/, '$1')); // Remove quotes
      }
      pasteData.push(cells);
    });

    // Ensure we have enough rows
    const neededRows = startRow + pasteData.length;
    const currentRows = tableBody.children.length;
    for (let i = currentRows; i < neededRows; i++) {
      addRow();
    }

    // Populate the cells
    pasteData.forEach((rowData, rowOffset) => {
      rowData.forEach((cellData, colOffset) => {
        const targetRow = startRow + rowOffset;
        const targetCol = startCol + colOffset;
        const colCount = getColumnCount();

        if (targetCol < colCount) {
          const cell = tableBody.querySelector(`input[data-row="${targetRow}"][data-col="${targetCol}"]`) as HTMLInputElement;
          if (cell) {
            cell.value = cellData || '';
          }
        }
      });
    });

    notifyDataChange();
  }

  function collectTableData(): string[][] {
    const rows: string[][] = [];
    const tableRows = tableBody.querySelectorAll('tr');

    tableRows.forEach(row => {
      const cells = row.querySelectorAll('.editable') as NodeListOf<HTMLInputElement>;
      const rowData: string[] = [];
      cells.forEach(cell => {
        rowData.push(cell.value || '');
      });
      rows.push(rowData);
    });

    return rows;
  }

  function updateDeleteButtonState() {
    const checkedBoxes = tableBody.querySelectorAll('.row-select:checked');
    deleteRowsBtn.disabled = checkedBoxes.length === 0;
  }

  function notifyDataChange() {
    const data = collectTableData();
    vscode.postMessage({
      command: 'tableDataChanged',
      data: data
    });
  }

  // Initialize delete button state
  updateDeleteButtonState();

  function focusFirstEditableCell() {
    const firstCell = tableBody.querySelector('.editable') as HTMLInputElement | null;
    if (firstCell) {
      firstCell.focus();
      firstCell.select();
    }
  }
}
