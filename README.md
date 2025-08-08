# Kahua Attribute Generator

Generate XML attribute definitions for Kahua apps or supplements directly from selected text in Visual Studio Code.

## Features

* **Two generation modes** via Command Palette or context menu:
  * **`Kahua: Generate Extension Attributes from Selection`** – Uses `kahua.defaultPrefix.extension` setting
  * **`Kahua: Generate Supplement Attributes from Selection`** – Uses `kahua.defaultPrefix.supplement` setting

* **Configurable token system** – Define your own token names and default values via `kahua.tokenNames` (e.g., `name,type:Text,visual:TextBox`)

* **Customizable XML fragments** – Modify, add, or remove output fragments via `kahua.fragments` setting

* **Flexible whitespace control** – Choose whether tokens preserve formatting (`{token:friendly}`) or are trimmed (`{token}`)

* **Multiple output options** – Copy to clipboard or open in new editor window

* **Comprehensive validation** – Clear error messages for configuration and input issues

* **Token value table** – Shows token assignments for each processed line in output

## Usage

1. Install the extension via the VSIX package or clone this repository and run `npm install` followed by `vsce package` to build a VSIX.
2. Select one or more lines of text in your editor. Each line should contain comma‑separated values corresponding to your configured tokens:

   **Default token format** (`name,prefix,type,label`):
   * **`AttributeName`** – Uses defaults for missing tokens
   * **`AttributeName,MyPrefix`** – Provides name and custom prefix
   * **`AttributeName,MyPrefix,Integer`** – Adds explicit data type
   * **`AttributeName,MyPrefix,Integer,Friendly Display Name`** – All four tokens

   **Custom token example** (if `kahua.tokenNames` = `"name,prefix,category,status"`):
   * **`FieldName,MyApp,Important,Active`** – All custom tokens provided

   Whitespace handling depends on fragment configuration (see Token Whitespace Control below).

3. Open the Command Palette (`Ctrl+Shift+P` / `⌘⇧P`) and run **`Kahua: Generate Extension Attributes from Selection`** or **`Kahua: Generate Supplement Attributes from Selection`** depending on your context.
4. The generated XML is either copied to your clipboard or opened in a new editor window (configurable via `kahua.outputTarget`).

## Configuration

You can override the following settings in your workspace or user `settings.json`:

| Setting | Default | Description |
| --- | --- | --- |
| `kahua.showInContextMenu` | `true` | Show Kahua generator commands in the editor right-click context menu |
| `kahua.outputTarget` | `"newEditor"` | Choose where to output generated XML: `"clipboard"` or `"newEditor"` |
| `kahua.tokenNames` | `"name,entity,type,label,visualtype:TextBox"` | Comma-separated list of token names with optional defaults (format: `token:defaultValue`) |
| `kahua.fragments` | See below | Object containing customizable XML fragment templates |
| `kahua.defaultPrefix.extension` | `""` | Default prefix when generating app‑style attributes |
| `kahua.defaultPrefix.supplement` | `"Inspections"` | Default prefix when generating supplement‑style attributes |

## Token Configuration

### Configurable Token Names

The extension uses a configurable token system via the `kahua.tokenNames` setting. This allows you to customize which tokens are parsed from your input and used in fragments.

**Default tokens**: `"name,entity,type,label,visualtype:TextBox"`

**Input format**: Each selected line should contain comma-separated values corresponding to your configured tokens:
- `FieldName` - Uses defaults for all missing tokens
- `FieldName,MyEntity` - Provides name and entity, uses defaults for type, label, visualtype
- `FieldName,MyEntity,Integer` - Provides name, entity, and type
- `FieldName,MyEntity,Integer,Friendly Name` - Provides all except visualtype (uses TextBox default)
- `FieldName,MyEntity,Integer,Friendly Name,ComboBox` - Provides all tokens

**Token Defaults**: Configure defaults using colon syntax in `kahua.tokenNames`:
- `name,entity,type:Text,label,visualtype:TextBox` - Sets default "Text" for type, "TextBox" for visualtype
- Missing input values automatically use the configured defaults

### Token Processing

All tokens are processed identically with no special built-in logic:

- **Missing tokens** default to empty string if not provided in input
- **Whitespace handling** depends on fragment template syntax (`{token}`, `{token:internal}`, or `{token:friendly}`)
- **No fallback logic** - what you input is what gets used (or empty string for missing values)

### Custom Tokens

You can define any token names you need:

```json
{
  "kahua.tokenNames": "name,prefix,type,label,category,owner,status"
}
```

All tokens use their corresponding input position or default to empty string if not provided.

## Error Handling

The extension validates configuration and input before generating XML:

### Configuration Validation
- **`kahua.tokenNames`** must be defined and contain valid token names
- **`kahua.fragments`** must be defined with valid fragment templates
- Invalid configuration shows an error notification with specific details

### Selection Validation  
- **Text selection** is required - empty selections show an error
- **Valid content** - selection must contain at least one non-empty line

### Token Table Output
Generated output includes a table showing token configuration and values for each processed line:

```
<!-- Token Configuration and Values Table -->
| Token     | Default | Line 1 | Line 2  |
|-----------|---------|--------|---------|
| name      |         | Field1 | Field2  |
| entity    |         | MyApp  | MyApp   |
| type      |         | Text   | Integer |
| label     |         | Field1 | Field2  |
| visualtype| TextBox | TextBox| ComboBox|
```

## Fragment System

### Default Fragments

The extension generates XML using configurable fragment templates in `kahua.fragments`:

```json
{
  "kahua.fragments": {
    "attribute": "<Attribute Name=\"{name}\" Label=\"[{prefix}_{name}Label]\" Description=\"[{prefix}_{name}Description]\" DataType=\"{type}\" IsConfigurable=\"true\" />",
    "label": "<Label Key=\"{prefix}_{name}Label\">{label:friendly}</Label>",
    "descriptionLabel": "<Label Key=\"{prefix}_{name}Description\">{label}</Label>",
    "dataTag": "<DataTag Name=\"{prefix}_{name}\" Key=\"{prefix}_{name}\" Label=\"[{prefix}_{name}Label]\" CultureLabelKey=\"{prefix}_{name}Label\" />",
    "field": "<Field Attribute=\"{name}\" />",
    "fieldDef": "<FieldDef Name=\"{name}\" Path=\"{name}\" DataTag=\"{prefix}_{name}\" Edit.Path=\"{name}\" />",
    "dataStoreColumn": "<Column AttributeName=\"{name}\" />",
    "logField": "<Field FieldDef=\"{name}\" />"
  }
}
```

### Token Whitespace Control

Fragments support three token formats for controlling whitespace:

- **`{token}`** - Default behavior, whitespace trimmed (same as `{token:internal}`)
- **`{token:internal}`** - Explicitly request trimmed whitespace
- **`{token:friendly}`** - Preserve original whitespace and formatting from input

**Examples**:
```xml
<!-- Trimmed whitespace (default) -->
<Label Key="MyPrefix_FieldName">{label}</Label>

<!-- Preserves original whitespace -->
<Label Key="MyPrefix_FieldName">{label:friendly}</Label>

<!-- Explicit trimmed (same as default) -->
<Label Key="MyPrefix_FieldName">{label:internal}</Label>
```

### Custom Fragments

You can add, remove, or modify fragments in your settings:

```json
{
  "kahua.fragments": {
    "attribute": "<Attribute Name=\"{name}\" DataType=\"{type}\" />",
    "customFragment": "<Custom {name}=\"{prefix}\" Category=\"{category}\" />",
    "anotherFragment": "<Another>{label:friendly}</Another>"
  }
}
```

### Fragment Examples

**Input**: `Field Name, MyApp, Integer, User Friendly Label`

**Generated Output**:
```xml
<!-- attribute -->
<Attribute Name="FieldName" Label="[MyApp_FieldNameLabel]" Description="[MyApp_FieldNameDescription]" DataType="Integer" IsConfigurable="true" />

<!-- label -->
<Label Key="MyApp_FieldNameLabel">User Friendly Label</Label>

<!-- descriptionLabel -->
<Label Key="MyApp_FieldNameDescription">Field Name</Label>

<!-- dataTag -->
<DataTag Name="MyApp_FieldName" Key="MyApp_FieldName" Label="[MyApp_FieldNameLabel]" CultureLabelKey="MyApp_FieldNameLabel" />

<!-- field -->
<Field Attribute="FieldName" />

<!-- fieldDef -->
<FieldDef Name="FieldName" Path="FieldName" DataTag="MyApp_FieldName" Edit.Path="FieldName" />

<!-- dataStoreColumn -->
<Column AttributeName="FieldName" />

<!-- logField -->
<Field FieldDef="FieldName" />
```

## Development

This repository contains TypeScript sources. To build:

```bash
npm install
npm run compile
```

To package as a VSIX (requires [`vsce`](https://github.com/microsoft/vscode-vsce)):

```bash
npm run package
```

After packaging, install the resulting `.vsix` file via the Extensions view in VS Code.

## License

MIT