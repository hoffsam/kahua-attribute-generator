# Implementation Plan: XML Target Selection & Output Improvements

## Summary
1. **Snippet/Template commands**: Open in new editor tab instead of inserting at cursor
2. **Generate commands**: Show quick pick to select target XML file for injection
3. **Current file option**: If running from XML file, show it as an option in quick pick

---

## Step 1: Modify Snippet Generation - Open in New Editor
**File**: `src/extension.ts`
**Function**: `generateSnippetForFragments` (lines 933-1083)

**Changes**:
- Remove requirement for active editor (lines 934-938)
- Replace `editor.insertSnippet(snippet)` (lines 1066-1070) with:
  ```typescript
  const newDocument = await vscode.workspace.openTextDocument({
    content: snippetText,
    language: 'plaintext'
  });
  await vscode.window.showTextDocument(newDocument, {
    viewColumn: vscode.ViewColumn.Beside,
    preview: false
  });
  ```
- Update message: "opened in new editor" instead of "inserted" (line 1077)

---

## Step 2: Modify Template Generation - Open in New Editor
**File**: `src/extension.ts`
**Function**: `generateTemplateForFragments` (lines 1088-1168)

**Changes**:
- Remove requirement for active editor (lines 1089-1093)
- Replace `editor.edit()` insertion (lines 1156-1160) with:
  ```typescript
  const newDocument = await vscode.workspace.openTextDocument({
    content: templateText,
    language: 'plaintext'
  });
  await vscode.window.showTextDocument(newDocument, {
    viewColumn: vscode.ViewColumn.Beside,
    preview: false
  });
  ```
- Update message: "opened in new editor" instead of "inserted" (line 1162)

---

## Step 3: Create Helper - Find XML Files
**File**: `src/extension.ts`
**Location**: After utility functions (after line 247)

**New Function**:
```typescript
async function findXmlFilesInWorkspace(): Promise<vscode.Uri[]> {
  const files = await vscode.workspace.findFiles(
    '**/*.xml',
    '{**/node_modules/**,**/out/**,**/.vscode/**}'
  );
  return files.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
}
```

---

## Step 4: Create Helper - Get Relative Path
**File**: `src/extension.ts`
**Location**: After `findXmlFilesInWorkspace`

**New Function**:
```typescript
function getWorkspaceRelativePath(uri: vscode.Uri): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (workspaceFolder) {
    return vscode.workspace.asRelativePath(uri, false);
  }
  return uri.fsPath;
}
```

---

## Step 5: Create Output Target Type
**File**: `src/extension.ts`
**Location**: After interfaces (after line 55)

**New Types**:
```typescript
type OutputTarget =
  | { type: 'currentFile'; uri: vscode.Uri }
  | { type: 'selectFile'; uri: vscode.Uri }
  | { type: 'newEditor' }
  | { type: 'clipboard' };
```

---

## Step 6: Create Quick Pick - Select Output Target
**File**: `src/extension.ts`
**Location**: After helper functions

**New Function**:
```typescript
async function showOutputTargetQuickPick(currentFileUri?: vscode.Uri): Promise<OutputTarget | undefined> {
  const items: vscode.QuickPickItem[] = [];

  // Option 1: Current XML file (if applicable)
  const isCurrentFileXml = currentFileUri?.fsPath.toLowerCase().endsWith('.xml');
  if (isCurrentFileXml && currentFileUri) {
    items.push({
      label: `$(file) Current File`,
      description: getWorkspaceRelativePath(currentFileUri),
      detail: 'Insert into the current XML file at cursor position',
      alwaysShow: true
    });
  }

  // Option 2: Select XML file from workspace
  const xmlFiles = await findXmlFilesInWorkspace();
  if (xmlFiles.length > 0) {
    items.push({
      label: `$(search) Select XML File...`,
      description: `${xmlFiles.length} XML file(s) found in workspace`,
      detail: 'Choose a specific XML file to insert into',
      alwaysShow: true
    });
  }

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
  if (selected.label.includes('Current File') && currentFileUri) {
    return { type: 'currentFile', uri: currentFileUri };
  } else if (selected.label.includes('Select XML File')) {
    const fileItems = xmlFiles.map(uri => ({
      label: getWorkspaceRelativePath(uri),
      description: uri.fsPath,
      uri
    }));

    const selectedFile = await vscode.window.showQuickPick(fileItems, {
      placeHolder: 'Select an XML file',
      title: 'Kahua: Choose XML File'
    });

    if (!selectedFile) {
      return undefined;
    }

    return { type: 'selectFile', uri: selectedFile.uri };
  } else if (selected.label.includes('New Editor Tab')) {
    return { type: 'newEditor' };
  } else {
    return { type: 'clipboard' };
  }
}
```

---

## Step 7: Create Helper - Insert into File
**File**: `src/extension.ts`
**Location**: After `showOutputTargetQuickPick`

**New Function**:
```typescript
async function insertXmlIntoFile(uri: vscode.Uri, content: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, {
    preserveFocus: false,
    preview: false
  });

  // Insert at current cursor position, or end of file if no selection
  const position = editor.selection.active;
  await editor.edit(editBuilder => {
    editBuilder.insert(position, '\n' + content + '\n');
  });

  // Move cursor to end of inserted content
  const lines = content.split('\n').length;
  const newPosition = position.translate(lines + 2, 0);
  editor.selection = new vscode.Selection(newPosition, newPosition);
}
```

---

## Step 8: Modify handleSelection - Add Quick Pick
**File**: `src/extension.ts`
**Function**: `handleSelection` (lines 1184-1557)

**Changes at lines 1533-1551**:

Replace:
```typescript
// Get the output target setting
const outputTarget = config.get<string>('outputTarget') || 'newEditor';

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
```

With:
```typescript
// Show quick pick to select output target
const currentFileUri = editor?.document?.uri;
const target = await showOutputTargetQuickPick(currentFileUri);

if (!target) {
  vscode.window.showInformationMessage('Kahua: Generation cancelled');
  return;
}

// Handle selected output target
switch (target.type) {
  case 'currentFile':
    await insertXmlIntoFile(target.uri, generatedXml);
    vscode.window.showInformationMessage(
      `Kahua: Generated fragments for ${fragmentIds.join(', ')} inserted into current file`
    );
    break;

  case 'selectFile':
    await insertXmlIntoFile(target.uri, generatedXml);
    const fileName = getWorkspaceRelativePath(target.uri);
    vscode.window.showInformationMessage(
      `Kahua: Generated fragments for ${fragmentIds.join(', ')} inserted into ${fileName}`
    );
    break;

  case 'newEditor':
    const newDocument = await vscode.workspace.openTextDocument({
      content: generatedXml,
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

  case 'clipboard':
    await vscode.env.clipboard.writeText(generatedXml);
    vscode.window.showInformationMessage(
      `Kahua: Generated fragments for ${fragmentIds.join(', ')} copied to clipboard`
    );
    break;
}
```

---

## Step 9: Enhanced XML Injection - Parse Generated Output Structure

**Purpose**: Understand the structure of generated XML to enable smart injection

**Requirements**:
- Parse the generated XML output to identify sections (comment headers)
- Extract section names and content
- Return a structured map of sections

**New Interface**:
```typescript
interface XmlSection {
  name: string;          // e.g., "Attributes", "Labels", "DataTags"
  content: string;       // The actual XML content
  startLine: number;     // Line number in generated output
  endLine: number;       // Line number in generated output
}
```

**New Function** (add after `insertXmlIntoFile`):
```typescript
function parseGeneratedXmlSections(generatedXml: string): XmlSection[] {
  const sections: XmlSection[] = [];
  const lines = generatedXml.split('\n');
  let currentSection: XmlSection | null = null;
  const sectionContent: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Detect section headers: <!-- SectionName -->
    const headerMatch = line.match(/^<!--\s*(.+?)\s*-->$/);

    if (headerMatch) {
      // Save previous section if exists
      if (currentSection) {
        currentSection.content = sectionContent.join('\n').trim();
        currentSection.endLine = i - 1;
        sections.push(currentSection);
        sectionContent.length = 0;
      }

      // Start new section
      currentSection = {
        name: headerMatch[1],
        content: '',
        startLine: i + 1,
        endLine: i + 1
      };
    } else if (currentSection && line && !line.startsWith('<!--')) {
      // Add non-comment, non-empty lines to current section
      sectionContent.push(lines[i]);
    }
  }

  // Save final section
  if (currentSection && sectionContent.length > 0) {
    currentSection.content = sectionContent.join('\n').trim();
    currentSection.endLine = lines.length - 1;
    sections.push(currentSection);
  }

  return sections;
}
```

---

## Step 10: Enhanced XML Injection - Parse Target File Structure

**Purpose**: Parse the target XML file to find existing sections where content can be injected

**Requirements**:
- Parse target XML file to find common section tags
- Support common Kahua XML sections: `<Attributes>`, `<Labels>`, `<DataTags>`, `<Fields>`, `<FieldDefs>`, `<DataStoreColumns>`, `<LookupList>`, etc.
- Find opening and closing tags
- Detect indentation level
- Handle nested structures

**New Interface**:
```typescript
interface XmlTargetSection {
  tagName: string;              // e.g., "Attributes", "Labels"
  openTagLine: number;          // Line number of opening tag
  closeTagLine: number;         // Line number of closing tag
  indentation: string;          // Whitespace prefix for indentation
  isSelfClosing: boolean;       // True if <Tag />
  lastChildLine: number;        // Line number of last child element
}
```

**New Function** (add after `parseGeneratedXmlSections`):
```typescript
function parseTargetXmlStructure(document: vscode.TextDocument): XmlTargetSection[] {
  const sections: XmlTargetSection[] = [];
  const commonTags = [
    'Attributes', 'Labels', 'DataTags', 'Fields', 'FieldDefs',
    'DataStoreColumns', 'LookupList', 'LookupLists', 'LogFields',
    'ImportDefs', 'Visuals', 'EntityDef', 'AppDef'
  ];

  for (let lineNum = 0; lineNum < document.lineCount; lineNum++) {
    const line = document.lineAt(lineNum);
    const text = line.text;

    for (const tagName of commonTags) {
      // Match opening tag: <TagName> or <TagName ...>
      const openMatch = text.match(new RegExp(`^(\\s*)<${tagName}[\\s>]`));
      if (openMatch) {
        const indentation = openMatch[1];
        const isSelfClosing = text.includes('/>');

        if (isSelfClosing) {
          sections.push({
            tagName,
            openTagLine: lineNum,
            closeTagLine: lineNum,
            indentation,
            isSelfClosing: true,
            lastChildLine: lineNum
          });
        } else {
          // Find closing tag
          const closeTagLine = findClosingTag(document, tagName, lineNum);
          const lastChildLine = findLastChildElement(document, lineNum, closeTagLine);

          sections.push({
            tagName,
            openTagLine: lineNum,
            closeTagLine,
            indentation,
            isSelfClosing: false,
            lastChildLine
          });
        }
      }
    }
  }

  return sections;
}

function findClosingTag(document: vscode.TextDocument, tagName: string, startLine: number): number {
  let depth = 1;
  for (let i = startLine + 1; i < document.lineCount; i++) {
    const text = document.lineAt(i).text;
    if (text.includes(`<${tagName}`)) depth++;
    if (text.includes(`</${tagName}>`)) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return startLine; // Fallback
}

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
```

---

## Step 11: Enhanced XML Injection - Smart Section Matching

**Purpose**: Match generated sections to target file sections intelligently

**Requirements**:
- Match generated section names to target XML tag names
- Handle variations: "Attributes" matches `<Attributes>`, "Extension Attributes" matches `<Attributes>`, etc.
- Handle partial matches and pluralization
- Return mapping of which generated sections can go into which target sections

**New Function** (add after `parseTargetXmlStructure`):
```typescript
function matchSectionsToTargets(
  generatedSections: XmlSection[],
  targetSections: XmlTargetSection[]
): Map<string, XmlTargetSection | null> {
  const matches = new Map<string, XmlTargetSection | null>();

  for (const genSection of generatedSections) {
    let bestMatch: XmlTargetSection | null = null;

    // Extract key words from generated section name
    // e.g., "Extension Attributes - Attributes" -> ["Attributes"]
    const genWords = genSection.name
      .toLowerCase()
      .replace(/extension|supplement|group \d+|default/gi, '')
      .split(/[-\s]+/)
      .filter(w => w.length > 2);

    for (const targetSection of targetSections) {
      const targetName = targetSection.tagName.toLowerCase();

      // Check if any word from generated section matches target
      for (const word of genWords) {
        // Direct match or plural match
        if (targetName === word ||
            targetName === word + 's' ||
            targetName + 's' === word ||
            targetName.includes(word) ||
            word.includes(targetName)) {
          bestMatch = targetSection;
          break;
        }
      }

      if (bestMatch) break;
    }

    matches.set(genSection.name, bestMatch);
  }

  return matches;
}
```

---

## Step 12: Enhanced XML Injection - Insertion Strategy

**Purpose**: Determine HOW and WHERE to insert content based on user preference

**Requirements**:
- Offer user two insertion strategies via quick pick:
  1. **Smart Insertion**: Automatically detect sections and insert into appropriate places
  2. **Cursor Position**: Insert all content at current cursor position (simple, current behavior)

**New Type**:
```typescript
type InsertionStrategy = 'smart' | 'cursor';
```

**New Function** (add after `matchSectionsToTargets`):
```typescript
async function showInsertionStrategyPick(
  hasMatchableSections: boolean
): Promise<InsertionStrategy | undefined> {
  if (!hasMatchableSections) {
    // No smart options available, just use cursor
    return 'cursor';
  }

  const items: vscode.QuickPickItem[] = [
    {
      label: '$(symbol-method) Smart Insertion',
      detail: 'Automatically insert fragments into matching XML sections',
      alwaysShow: true
    },
    {
      label: '$(edit) Cursor Position',
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
```

---

## Step 13: Enhanced XML Injection - Smart Insertion Implementation

**Purpose**: Implement smart insertion that places each section in the correct location

**Requirements**:
- For each generated section, find its matching target section
- Insert content at the appropriate position (after last child, before closing tag)
- Preserve and match indentation
- Handle sections with no match (show warning or insert at cursor)
- Perform all insertions in a single edit operation

**Update Function**: Replace `insertXmlIntoFile` from Step 7 with:

```typescript
async function insertXmlIntoFile(
  uri: vscode.Uri,
  content: string,
  strategy?: InsertionStrategy
): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, {
    preserveFocus: false,
    preview: false
  });

  if (!strategy || strategy === 'cursor') {
    // Simple insertion at cursor position
    const position = editor.selection.active;
    await editor.edit(editBuilder => {
      editBuilder.insert(position, '\n' + content + '\n');
    });

    const lines = content.split('\n').length;
    const newPosition = position.translate(lines + 2, 0);
    editor.selection = new vscode.Selection(newPosition, newPosition);
    return;
  }

  // Smart insertion
  const generatedSections = parseGeneratedXmlSections(content);
  const targetSections = parseTargetXmlStructure(document);
  const matches = matchSectionsToTargets(generatedSections, targetSections);

  // Prompt user for strategy
  const insertionStrategy = await showInsertionStrategyPick(
    Array.from(matches.values()).some(m => m !== null)
  );

  if (!insertionStrategy) {
    return; // User cancelled
  }

  if (insertionStrategy === 'cursor') {
    // Fall back to cursor insertion
    const position = editor.selection.active;
    await editor.edit(editBuilder => {
      editBuilder.insert(position, '\n' + content + '\n');
    });
    return;
  }

  // Perform smart insertion
  await editor.edit(editBuilder => {
    const unmatchedSections: string[] = [];

    for (const [sectionName, targetSection] of matches.entries()) {
      const genSection = generatedSections.find(s => s.name === sectionName);
      if (!genSection) continue;

      if (targetSection) {
        // Insert into matched section
        const insertLine = targetSection.lastChildLine;
        const insertPosition = document.lineAt(insertLine).range.end;
        const indentedContent = indentContent(
          genSection.content,
          targetSection.indentation + '  '
        );

        editBuilder.insert(
          insertPosition,
          '\n' + indentedContent
        );
      } else {
        unmatchedSections.push(sectionName);
      }
    }

    // Handle unmatched sections - insert at cursor
    if (unmatchedSections.length > 0) {
      const unmatchedContent = unmatchedSections
        .map(name => {
          const section = generatedSections.find(s => s.name === name);
          return section ? `\n<!-- ${section.name} -->\n${section.content}` : '';
        })
        .join('\n');

      const position = editor.selection.active;
      editBuilder.insert(position, '\n' + unmatchedContent + '\n');
    }
  });

  // Show warnings for unmatched sections
  const unmatchedCount = Array.from(matches.values()).filter(m => m === null).length;
  if (unmatchedCount > 0) {
    vscode.window.showWarningMessage(
      `Kahua: ${unmatchedCount} section(s) could not be matched and were inserted at cursor position`
    );
  }
}

function indentContent(content: string, indentation: string): string {
  return content
    .split('\n')
    .map(line => line.trim() ? indentation + line : line)
    .join('\n');
}
```

---

## Step 14: Update handleSelection to Support Smart Insertion

**Changes to Step 8 code**:

Update the `currentFile` and `selectFile` cases:

```typescript
case 'currentFile':
  await insertXmlIntoFile(target.uri, generatedXml, 'smart');
  vscode.window.showInformationMessage(
    `Kahua: Generated fragments for ${fragmentIds.join(', ')} inserted into current file`
  );
  break;

case 'selectFile':
  await insertXmlIntoFile(target.uri, generatedXml, 'smart');
  const fileName = getWorkspaceRelativePath(target.uri);
  vscode.window.showInformationMessage(
    `Kahua: Generated fragments for ${fragmentIds.join(', ')} inserted into ${fileName}`
  );
  break;
```

---

## Step 15: Testing Checklist for Smart Injection

### Test 9: Smart Insertion - All Sections Match
- [ ] Create an XML file with sections: `<Attributes>`, `<Labels>`, `<DataTags>`
- [ ] Generate attributes that create these three sections
- [ ] Select XML file as target
- [ ] Choose "Smart Insertion"
- [ ] Verify each section inserted into correct XML tag
- [ ] Verify indentation matches target file

### Test 10: Smart Insertion - Partial Match
- [ ] Create an XML file with only `<Attributes>` section
- [ ] Generate attributes that create Attributes, Labels, and DataTags
- [ ] Select XML file as target
- [ ] Choose "Smart Insertion"
- [ ] Verify Attributes inserted into `<Attributes>`
- [ ] Verify Labels and DataTags inserted at cursor with warning

### Test 11: Smart Insertion - No Matches
- [ ] Create an XML file with no matching sections
- [ ] Generate attributes
- [ ] Select XML file as target
- [ ] Verify strategy automatically falls back to cursor insertion

### Test 12: Cursor Insertion Fallback
- [ ] Generate attributes
- [ ] Select XML file as target
- [ ] Choose "Cursor Position"
- [ ] Verify all content inserted at cursor as a single block

### Test 13: Indentation Preservation
- [ ] Create XML with 4-space indentation
- [ ] Generate attributes
- [ ] Use smart insertion
- [ ] Verify inserted content matches 4-space indentation

### Test 14: Nested Section Handling
- [ ] Create XML with nested `<EntityDef>` containing `<Attributes>`
- [ ] Generate attributes
- [ ] Verify content inserted into correct nested section

---

## Step 16: Testing Checklist (Original Tests)

### Test 1: Snippet Command
- [ ] Run "Generate Snippet for Attributes"
- [ ] Verify opens in new editor tab
- [ ] Verify plaintext content (not snippet syntax)
- [ ] Verify message says "opened in new editor"

### Test 2: Template Command
- [ ] Run "Generate Template for Attributes"
- [ ] Verify opens in new editor tab
- [ ] Verify message says "opened in new editor"

### Test 3: Generate from XML File
- [ ] Open an XML file with some text selected
- [ ] Run "Generate Attributes for Extension"
- [ ] Verify quick pick shows "Current File" at top
- [ ] Select "Current File"
- [ ] Verify insertion strategy prompt appears
- [ ] Test both smart and cursor insertion modes

### Test 4: Generate from Non-XML File
- [ ] Open a .txt or .md file with text selected
- [ ] Run "Generate Attributes for Extension"
- [ ] Verify "Current File" option NOT shown
- [ ] Verify other options are shown

### Test 5: Select XML File Option
- [ ] Run generate command
- [ ] Choose "Select XML File..."
- [ ] Verify second quick pick shows workspace XML files
- [ ] Select a file
- [ ] Verify insertion strategy prompt appears

### Test 6: New Editor Option
- [ ] Run generate command
- [ ] Choose "New Editor Tab"
- [ ] Verify XML opens in new editor

### Test 7: Clipboard Option
- [ ] Run generate command
- [ ] Choose "Clipboard"
- [ ] Verify clipboard contains XML

### Test 8: Cancel Quick Pick
- [ ] Run generate command
- [ ] Press Escape at any prompt
- [ ] Verify cancellation message shown
- [ ] Verify no changes made

---

## Implementation Order

1. ✅ Step 1: Modify snippet generation (open in new editor)
2. ✅ Step 2: Modify template generation (open in new editor)
3. ✅ Step 3-4: Create helper functions (findXmlFiles, getRelativePath)
4. ✅ Step 5: Create OutputTarget type
5. ✅ Step 6: Create quick pick for output target selection
6. ✅ Step 7: Create basic insertXmlIntoFile helper (cursor mode)
7. ✅ Step 8: Modify handleSelection to use quick pick
8. ✅ Step 9: Add parseGeneratedXmlSections function
9. ✅ Step 10: Add parseTargetXmlStructure function
10. ✅ Step 11: Add matchSectionsToTargets function
11. ✅ Step 12: Add showInsertionStrategyPick function
12. ✅ Step 13: Enhance insertXmlIntoFile with smart insertion
13. ✅ Step 14: Update handleSelection to pass 'smart' strategy
14. ✅ Step 15: Test smart injection features
15. ✅ Step 16: Test all original features

**Workflow per step**: Implement → Review → Test → Iterate → Confirm → Next step

---

## Notes

- Steps 1-8 are the **basic implementation** (quick pick, open in new tab)
- Steps 9-14 are the **enhanced smart injection** features
- Can be implemented and tested incrementally
- Smart injection is opt-in via quick pick selection
