# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

- **Compile TypeScript**: `npm run compile` - Compiles TypeScript to JavaScript in the `out/` directory
- **Watch mode**: `npm run watch` - Compiles TypeScript in watch mode for development
- **Package extension**: `npm run package` or `vsce package` - Creates a .vsix file for installation
- **Full build**: `npm run build` - Compiles and packages the extension
- **Clean build**: `npm run build-clean` - Removes output directory, compiles, and packages

## Project Architecture

This is a VS Code extension for generating Kahua XML attribute definitions. The extension follows the standard VS Code extension architecture:

### Core Structure
- `src/extension.ts` - Single main entry point containing all extension logic
- `package.json` - Extension manifest with commands, menus, keybindings, and configuration schema
- `out/` - Compiled JavaScript output directory
- TypeScript compilation target: ES2022, CommonJS modules

### Extension Functionality
The extension provides two main commands that process selected text to generate XML fragments:
- `kahua.createExtensionAttributes` (Ctrl+Alt+E) - For app extensions
- `kahua.createSupplementAttributes` (Ctrl+Alt+S) - For supplements

### Input Processing Pattern
The extension processes selected lines based on configurable token names defined in `kahua.tokenNames` setting:
- Default format: `AttributeName,Prefix,DataType,Label` (corresponding to tokens: name,prefix,type,label)
- Token names can be customized in settings as a comma-separated list
- Built-in token handling:
  - `name` - Sanitizes input by removing non-alphanumeric characters
  - `label` - Uses original unsanitized input text
  - `prefix` - Falls back to document's first `<EntityDef Name="...">` then mode default
  - `type` - Defaults to "Text" if not specified
  - Custom tokens use corresponding input parts or empty string

### Template System
XML generation uses configurable fragment templates from `kahua.fragments` configuration:
- `attribute` - Main attribute definition with label/description tokens
- `label` - Label entry for localization
- `descriptionLabel` - Description label entry  
- `dataTag` - Metadata tag definition
- `field` - Field reference for datastore
- `fieldDef` - Field definition linking attribute to data tag
- `dataStoreColumn` - Database column mapping
- `logField` - Field reference for logging

### Configuration Schema
Key settings in package.json contributions:
- `kahua.showInContextMenu` - Toggle context menu visibility
- `kahua.outputTarget` - Choose between clipboard or new editor output
- `kahua.tokenNames` - Comma-separated list of configurable token names (default: "name,prefix,type,label")
- `kahua.fragments` - Customizable XML fragment templates with token replacement

### Token Replacement System
Templates support configurable tokens defined in `kahua.tokenNames`:
- Tokens are dynamically parsed from input based on configuration
- Each token corresponds to a comma-separated value in the selected text
- Built-in tokens (name, label, prefix, type) have special handling logic
- Custom tokens use their corresponding input position or default to empty string

**Token Whitespace Control:**
- `{token}` - Default behavior, whitespace trimmed (same as `{token:internal}`)
- `{token:internal}` - Explicitly request trimmed whitespace 
- `{token:friendly}` - Preserve original whitespace and formatting from input
- All tokens can be used with any whitespace mode in fragment templates