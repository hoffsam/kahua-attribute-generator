# Kahua Attribute Generator

Generate XML attribute definitions for Kahua apps or supplements directly from selected text in Visual Studio Code.

## Features

* **Two generation modes** via Command Palette or context menu:
  * **`Kahua: Generate Extension Attributes from Selection`** – Uses `kahua.defaultPrefix.extension` setting
  * **`Kahua: Generate Supplement Attributes from Selection`** – Uses `kahua.defaultPrefix.supplement` setting

* **Configurable token system** – Define your own token names and default values via `kahua.tokenNames` (e.g., `name,type:Text,visual:TextBox`)

* **Customizable XML fragments** – Modify, add, or remove output fragments via `kahua.fragments` setting

* **Flexible whitespace control** – Choose whether tokens preserve formatting (`{$token:friendly}`) or are trimmed (`{$token}`)

* **Conditional blocks** – Generate dynamic XML with conditional expressions based on token values

* **Advanced token syntax** – Support for `{$token}` prefixing and conditional expressions (`{$condition ? 'value' : 'fallback'}`)

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
| `kahua.suppressInvalidConditionWarnings` | `false` | Suppress error notifications when conditional expressions reference invalid tokens |
| `kahua.fragments` | See below | Object containing customizable XML fragment templates with conditional support |

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

### Token Defaults

The extension supports configurable default values for tokens using colon syntax in `kahua.tokenNames`. This powerful feature ensures consistent output even when input data is incomplete.

#### Default Configuration Syntax

Use the format `tokenName:defaultValue` in the `kahua.tokenNames` setting:

```json
{
  "kahua.tokenNames": "name,entity,type:Text,label,visualtype:TextBox,required:false"
}
```

#### How Defaults Work

1. **Input parsing**: Each comma-separated input line is matched to tokens by position
2. **Missing values**: When input has fewer values than configured tokens, defaults are used
3. **Empty values**: Blank input values (empty strings) use defaults
4. **Priority**: Input values always override defaults when provided

#### Default Examples

**Configuration**: `"name,entity,type:Text,label,visualtype:TextBox,category:Standard"`

**Input Scenarios**:

| Input | Result |
|-------|---------|
| `FieldA` | `name=FieldA, entity=, type=Text, label=, visualtype=TextBox, category=Standard` |
| `FieldA,MyEntity` | `name=FieldA, entity=MyEntity, type=Text, label=, visualtype=TextBox, category=Standard` |
| `FieldA,MyEntity,Integer` | `name=FieldA, entity=MyEntity, type=Integer, label=, visualtype=TextBox, category=Standard` |
| `FieldA,MyEntity,,Custom Label` | `name=FieldA, entity=MyEntity, type=Text, label=Custom Label, visualtype=TextBox, category=Standard` |
| `FieldA,MyEntity,Lookup,Field A,ComboBox,Advanced` | `name=FieldA, entity=MyEntity, type=Lookup, label=Field A, visualtype=ComboBox, category=Advanced` |

#### Conditional Interaction

Defaults work seamlessly with conditional expressions:

**Fragment**: `{$type=='Text' ? 'simple' : 'complex'}`
- **Input**: `FieldName,Entity` (type defaults to "Text")
- **Result**: "simple" (condition uses default value)

### Token Processing

All tokens are processed identically with no special built-in logic:

- **Default values** - missing or empty input values use configured defaults from `kahua.tokenNames` 
- **Whitespace handling** - depends on fragment template syntax (`{$token}`, `{$token:internal}`, or `{$token:friendly}`)
- **Conditional support** - tokens can be used in conditional expressions for dynamic content generation
- **No fallback logic** - input values and configured defaults are used directly without modification

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
    "Attributes": "<Attribute Name=\"{$name}\" Label=\"[{$entity}_{$name}Label]\" Description=\"[{$entity}_{$name}Description]\" DataType=\"{$type}\" IsConfigurable=\"true\" />",
    "Labels": "<Label Key=\"{$entity}_{$name}Label\">{$label:friendly}</Label>\n<Label Key=\"{$entity}_{$name}Description\">{$label}</Label>",
    "DataTags": "<DataTag Name=\"{$entity}_{$name}\" Key=\"{$entity}_{$name}\" Label=\"[{$entity}_{$name}Label]\" CultureLabelKey=\"{$entity}_{$name}Label\">\n  <Key />\n</DataTag>",
    "Fields": "<Field Attribute=\"{$name}\" />",
    "FieldDefs": "<FieldDef Name=\"{$name}\" Path=\"{$name}\" DataTag=\"{$entity}_{$name}\" Edit.Path=\"{$name}\" />",
    "DataStore": "<Column AttributeName=\"{$name}\" />",
    "LogFields": "<Field FieldDef=\"{$name}\" />",
    "ImportDefs": "<Column AttributeName=\"{$name}\" Name=\"{$name:friendly}\" />",
    "Visuals": "<TextBlock Name=\"{$name}\" DataTag=\"{$entity}_{$name}\" Path=\"{$name}\" />\n<{$visualtype} Name=\"{$name}\" DataTag=\"{$entity}_{$name}\" Path=\"{$name}\" {$type=='Lookup' ? 'LookupListName=\"{$name}\"' : ''} />",
    "{$type=='Lookup' ? 'LookupList' : ''}": "<LookupList Name=\"{$name}\" />\n<Value />"
  }
}
```

### Token Syntax and Whitespace Control

Fragments support the new `{$token}` syntax with three formats for controlling whitespace:

- **`{$token}`** - Default behavior, whitespace trimmed (same as `{$token:internal}`)
- **`{$token:internal}`** - Explicitly request trimmed whitespace  
- **`{$token:friendly}`** - Preserve original whitespace and formatting from input

**Examples**:
```xml
<!-- Trimmed whitespace (default) -->
<Label Key="MyEntity_FieldName">{$label}</Label>

<!-- Preserves original whitespace -->
<Label Key="MyEntity_FieldName">{$label:friendly}</Label>

<!-- Explicit trimmed (same as default) -->
<Label Key="MyEntity_FieldName">{$label:internal}</Label>
```

**Backward Compatibility**: The old `{token}` syntax is still supported for existing configurations.

### Conditional Blocks

The extension supports conditional expressions for dynamic XML generation based on token values.

#### Conditional Expression Syntax

Conditional expressions use the ternary operator format:
```
{$condition ? 'trueValue' : 'falseValue'}
```

#### Supported Operators

- **Equality**: `{$type=='Lookup' ? 'value' : ''}`
- **Inequality**: `{$type!='Text' ? 'value' : ''}` or `{$type<>'Text' ? 'value' : ''}`
- **Comparison**: `{$priority>=5 ? 'high' : 'normal'}`, `{$count<=10 ? 'few' : 'many'}`
- **List membership**: `{$status in ('Active','Pending') ? 'enabled' : 'disabled'}`
- **List exclusion**: `{$type not in ('Text','Integer') ? 'complex' : 'simple'}`

#### Conditional Fragment Values

Use conditionals within fragment templates to generate dynamic content:

```json
{
  "Visuals": "<{$visualtype} Name=\"{$name}\" {$type=='Lookup' ? 'LookupListName=\"{$name}\"' : ''} />"
}
```

**Input**: `FieldName,MyEntity,Lookup,Field Label,ComboBox`
**Output**: `<ComboBox Name="FieldName" LookupListName="FieldName" />`

**Input**: `FieldName,MyEntity,Text,Field Label,TextBox`
**Output**: `<TextBox Name="FieldName" />`

#### Conditional Fragment Keys

Use conditionals in fragment keys to include/exclude entire fragments based on conditions:

```json
{
  "{$type=='Lookup' ? 'LookupList' : ''}": "<LookupList Name=\"{$name}\" />\n<Value />"
}
```

- **When `type='Lookup'`**: Generates a `LookupList` fragment with the specified content
- **When `type='Text'`**: The entire fragment is omitted from output

#### Error Handling

- **Invalid tokens**: When conditions reference tokens that don't exist or are empty, the condition evaluates to `false`
- **Warning notifications**: By default, invalid token references show error notifications
- **Suppress warnings**: Set `kahua.suppressInvalidConditionWarnings: true` to disable notifications

#### Complete Conditional Example

**Configuration**:
```json
{
  "kahua.fragments": {
    "Controls": "<{$visualtype} Name=\"{$name}\" {$type=='Lookup' ? 'LookupListName=\"{$name}\"' : ''} {$required=='true' ? 'Required=\"true\"' : ''} />",
    "{$type=='Lookup' ? 'LookupDefinition' : ''}": "<LookupList Name=\"{$name}\">\n  <Value />\n</LookupList>",
    "{$category=='Advanced' ? 'AdvancedSettings' : ''}": "<Setting Name=\"{$name}\" Level=\"Advanced\" />"
  }
}
```

**Input Lines**:
```
FieldA,MyEntity,Lookup,Field A,ComboBox,true,Basic
FieldB,MyEntity,Text,Field B,TextBox,false,Advanced
FieldC,MyEntity,Lookup,Field C,ListBox,true,Advanced
```

**Output** (for FieldA - Lookup type):
```xml
<!-- Controls -->
<ComboBox Name="FieldA" LookupListName="FieldA" Required="true" />

<!-- LookupDefinition (included because type=='Lookup') -->
<LookupList Name="FieldA">
  <Value />
</LookupList>

<!-- AdvancedSettings fragment omitted (category=='Basic') -->
```

**Output** (for FieldB - Text type, Advanced category):
```xml
<!-- Controls -->
<TextBox Name="FieldB" />

<!-- LookupDefinition fragment omitted (type!='Lookup') -->

<!-- AdvancedSettings (included because category=='Advanced') -->
<Setting Name="FieldB" Level="Advanced" />
```

### Custom Fragments

You can add, remove, or modify fragments in your settings:

```json
{
  "kahua.fragments": {
    "Attributes": "<Attribute Name=\"{$name}\" DataType=\"{$type}\" />",
    "CustomFragment": "<Custom Name=\"{$name}\" Entity=\"{$entity}\" Category=\"{$category}\" />",
    "ConditionalFragment": "<Element {$type=='Special' ? 'SpecialAttr=\"true\"' : ''} >{$label:friendly}</Element>",
    "{$enabled=='true' ? 'EnabledElements' : ''}": "<Enabled Name=\"{$name}\" />"
  }
}
```

### Fragment Examples

**Input**: `FieldName,MyEntity,Integer,User Friendly Label,TextBox`

**Generated Output** (using default fragments):
```xml
<!-- Token Configuration and Values Table -->
| Token      | Default | Line 1              |
|------------|---------|---------------------|
| name       |         | FieldName           |
| entity     |         | MyEntity            |
| type       |         | Integer             |
| label      |         | User Friendly Label |
| visualtype | TextBox | TextBox             |

<!-- Attributes -->
<Attribute Name="FieldName" Label="[MyEntity_FieldNameLabel]" Description="[MyEntity_FieldNameDescription]" DataType="Integer" IsConfigurable="true" />

<!-- Labels -->
<Label Key="MyEntity_FieldNameLabel">User Friendly Label</Label>
<Label Key="MyEntity_FieldNameDescription">User Friendly Label</Label>

<!-- DataTags -->
<DataTag Name="MyEntity_FieldName" Key="MyEntity_FieldName" Label="[MyEntity_FieldNameLabel]" CultureLabelKey="MyEntity_FieldNameLabel">
  <Key />
</DataTag>

<!-- Fields -->
<Field Attribute="FieldName" />

<!-- FieldDefs -->
<FieldDef Name="FieldName" Path="FieldName" DataTag="MyEntity_FieldName" Edit.Path="FieldName" />

<!-- DataStore -->
<Column AttributeName="FieldName" />

<!-- LogFields -->
<Field FieldDef="FieldName" />

<!-- ImportDefs -->
<Column AttributeName="FieldName" Name="User Friendly Label" />

<!-- Visuals -->
<TextBlock Name="FieldName" DataTag="MyEntity_FieldName" Path="FieldName" />
<TextBox Name="FieldName" DataTag="MyEntity_FieldName" Path="FieldName"  />
```

## Quick Reference

### Token Syntax
- **Basic**: `{$tokenName}` - Uses token value with trimmed whitespace
- **Friendly**: `{$tokenName:friendly}` - Preserves original input whitespace
- **Internal**: `{$tokenName:internal}` - Explicitly trimmed (same as basic)

### Conditional Expressions
- **Ternary**: `{$condition ? 'trueValue' : 'falseValue'}`
- **Equality**: `{$type=='Lookup' ? 'value' : ''}`
- **Inequality**: `{$type!='Text' ? 'value' : ''}` or `{$type<>'Text' ? 'value' : ''}`
- **Comparison**: `{$count>=5 ? 'many' : 'few'}`
- **Lists**: `{$status in ('A','B') ? 'valid' : 'invalid'}`
- **Exclusion**: `{$type not in ('X','Y') ? 'special' : 'normal'}`

### Default Configuration
```json
{
  "kahua.tokenNames": "name,entity,type:Text,label,visualtype:TextBox",
  "kahua.suppressInvalidConditionWarnings": false,
  "kahua.fragments": {
    "FragmentName": "<Element Name=\"{$name}\" {$type=='Special' ? 'Extra=\"true\"' : ''} />",
    "{$enabled=='true' ? 'EnabledSection' : ''}": "<Section>{$content}</Section>"
  }
}
```

### Keyboard Shortcuts
- **Ctrl+Alt+E**: Generate Extension Attributes
- **Ctrl+Alt+S**: Generate Supplement Attributes

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