# Kahua Attribute Generator

Generate XML attribute definitions for Kahua apps or supplements directly from selected text in Visual Studio Code.

## Features

* **Two generation modes** via Command Palette or context menu:
  * **`Kahua: Generate Extension Attributes from Selection`** – Uses `kahua.defaultPrefix.extension` setting
  * **`Kahua: Generate Supplement Attributes from Selection`** – Uses `kahua.defaultPrefix.supplement` setting

* **Configurable token system** – Define your own token names and default values via `kahua.tokenNameDefinitions`

* **Customizable XML fragments** – Modify, add, or remove output fragments via `kahua.fragmentDefinitions` setting

* **Flexible transformations** – PascalCase for identifiers, TitleCase for display text, plus uppercase/lowercase options

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

   **Custom token example** with configured token definitions:
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
| `kahua.tokenNameDefinitions` | Array of token definitions | Define token sets with ID, name, type, and token list |
| `kahua.suppressInvalidConditionWarnings` | `false` | Suppress error notifications when conditional expressions reference invalid tokens |
| `kahua.fragmentDefinitions` | Array of fragment definitions | Define reusable fragment templates with conditional support |

## Token Configuration

### Token Name Definitions

The extension uses a flexible token definition system via `kahua.tokenNameDefinitions`. Each definition specifies:
- **id**: Unique identifier
- **name**: Display name
- **type**: Either "header" (single line) or "table" (row-by-row)
- **tokens**: Comma-separated token names with optional defaults

The extension uses configurable token definitions rather than a single `tokenNames` setting. See the **New Configuration System** section above for details.

**Input format**: Each selected line should contain comma-separated values corresponding to your configured tokens:
- `FieldName` - Uses defaults for all missing tokens
- `FieldName,MyEntity` - Provides name and entity, uses defaults for type, label, visualtype
- `FieldName,MyEntity,Integer` - Provides name, entity, and type
- `FieldName,MyEntity,Integer,Friendly Name` - Provides all except visualtype (uses TextBox default)
- `FieldName,MyEntity,Integer,Friendly Name,ComboBox` - Provides all tokens

### Token Defaults

The extension supports configurable default values for tokens using colon syntax in token definitions. This powerful feature ensures consistent output even when input data is incomplete.

#### Default Configuration Syntax

Use the format `tokenName:defaultValue` in token definition strings:

```json
{
  "kahua.tokenNameDefinitions": [
    {
      "id": "attributes",
      "name": "Attribute Tokens",
      "type": "table",
      "tokens": "name,entity,type:Text,label,visualtype:TextBox,required:false"
    }
  ]
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

- **Default values** - missing or empty input values use configured defaults from token definitions 
- **Transformation handling** - depends on fragment template syntax (`{$token}`, `{$token|internal}`, `{$token|friendly}`, `{$token|upper}`, `{$token|lower}`)
- **Conditional support** - tokens can be used in conditional expressions for dynamic content generation
- **No fallback logic** - input values and configured defaults are used directly without modification

### Custom Tokens

You can define any token names you need:

```json
{
  "kahua.tokenNameDefinitions": [
    {
      "id": "custom",
      "name": "Custom Tokens",
      "type": "table",
      "tokens": "name,prefix,type,label,category,owner,status"
    }
  ]
}
```

All tokens use their corresponding input position or default to empty string if not provided.

## Error Handling

The extension validates configuration and input before generating XML:

### Configuration Validation
- **`kahua.tokenNameDefinitions`** must be defined and contain valid token definitions
- **`kahua.fragmentDefinitions`** must be defined with valid fragment templates
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

### Fragment Structure Types

Fragment definitions support two main structure types:

#### 1. Grouped Structure (Default)
Traditional flat structure where each fragment key creates a separate section:

```json
{
  "fragments": {
    "body": {
      "Attributes": "<Attribute .../>",
      "Labels": "<Label .../>"
    }
  }
}
```

#### 2. Table Structure (Header/Body/Footer)
Structured format for lists and lookup tables:

```json
{
  "type": "table",
  "fragments": {
    "Lookups": {
      "header": "<LookupList ...>",
      "body": "  <Value .../>",
      "footer": "</LookupList>"
    },
    "Lookup Labels": {
      "header": "<Label Key=\"ListLabel\">...</Label>",
      "body": "<Label Key=\"ValueLabel\">...</Label>"
    }
  }
}
```

### Multiple Fragment Sets

A single fragment definition can contain multiple named fragment sets. For example, the lookup definition includes both "Lookups" and "Lookup Labels" sets, allowing generation of both the lookup structure and corresponding label definitions in a single operation.

### Default Fragments

The extension generates XML using configurable fragment templates in `kahua.fragmentDefinitions`. Here's an example of the structure:

```json
{
  "kahua.fragmentDefinitions": [{
    "id": "sample",
    "name": "Sample Fragment", 
    "tokenReferences": ["attributes"],
    "fragments": {
    "Attributes": "<Attribute Name=\"{$name}\" Label=\"[{$entity}_{$name}Label]\" Description=\"[{$entity}_{$name}Description]\" DataType=\"{$type}\" IsConfigurable=\"true\" />",
    "Labels": "<Label Key=\"{$entity}_{$name}Label\">{$label|friendly}</Label>\n<Label Key=\"{$entity}_{$name}Description\">{$label}</Label>",
    "DataTags": "<DataTag Name=\"{$entity}_{$name}\" Key=\"{$entity}_{$name}\" Label=\"[{$entity}_{$name}Label]\" CultureLabelKey=\"{$entity}_{$name}Label\">\n  <Key />\n</DataTag>",
    "Fields": "<Field Attribute=\"{$name}\" />",
    "FieldDefs": "<FieldDef Name=\"{$name}\" Path=\"{$name}\" DataTag=\"{$entity}_{$name}\" Edit.Path=\"{$name}\" />",
    "DataStore": "<Column AttributeName=\"{$name}\" />",
    "LogFields": "<Field FieldDef=\"{$name}\" />",
    "ImportDefs": "<Column AttributeName=\"{$name}\" Name=\"{$name|friendly}\" />",
    "Visuals": "<TextBlock Name=\"{$name}\" DataTag=\"{$entity}_{$name}\" Path=\"{$name}\" />\n<{$visualtype} Name=\"{$name}\" DataTag=\"{$entity}_{$name}\" Path=\"{$name}\" {$type=='Lookup' ? 'LookupListName=\"{$name}\"' : ''} />",
    "{$type=='Lookup' ? 'LookupList' : ''}": "<LookupList Name=\"{$name}\" />\n<Value />"
    }
  }]
}
```

### Token Syntax and Transformations

Fragments support the `{$token}` syntax with transformation options using the pipe (`|`) delimiter:

- **`{$token}`** - Default: PascalCase (strips spaces/special chars, capitalizes words)
- **`{$token|internal}`** - Explicitly creates PascalCase (same as default)
- **`{$token|friendly}`** - TitleCase with proper capitalization rules and XML escaping
- **`{$token|upper}`** - Convert to uppercase and XML-escape
- **`{$token|lower}`** - Convert to lowercase and XML-escape

**PascalCase**: Converts text to PascalCase while preserving existing PascalCase formatting. If input already has mixed case (like "MyEntityName"), it's preserved. Otherwise, removes spaces and special characters, capitalizes first letter of each word. Perfect for XML identifiers and attribute names.

**TitleCase**: Converts PascalCase and numbered text to properly spaced title case. Handles transitions like "ListNameIsThis" → "List Name Is This" and "Value1" → "Value 1". Applies proper title capitalization rules - capitalizes major words but keeps articles, prepositions, and conjunctions lowercase (except when first or last word). Preserves spaces and XML-escapes output.

**XML Escaping**: Applied to `friendly`, `upper`, and `lower` transformations. Special characters like `<`, `>`, `&`, `"`, and `'` are converted to their XML entity equivalents.

**Examples**:
```xml
<!-- Default: PascalCase for identifiers -->
<Attribute Name="{$name}" Label="[{$entity}_{$name}Label]" />
<!-- Input: "user field name" → Output: Name="UserFieldName" -->

<!-- Friendly: TitleCase for display text -->
<Label Key="MyEntity_FieldName">{$label|friendly}</Label>
<!-- Input: "field of the rings" → Output: "Field of the Rings" -->
<!-- Input: "fieldOfTheRings" → Output: "Field of the Rings" -->
<!-- Input: "Value1" → Output: "Value 1" -->
<!-- Input: "MyEntity123Name" → Output: "My Entity 123 Name" -->

<!-- Uppercase transformation -->
<Comment>{$description|upper}</Comment>
<!-- Input: "field & value" → Output: "FIELD &amp; VALUE" -->

<!-- Lowercase transformation -->
<Note>{$comment|lower}</Note>
<!-- Input: "FIELD & VALUE" → Output: "field &amp; value" -->
```

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
- **Logical AND**: `{$type=='Text' && $required=='true' ? 'required' : 'optional'}`
- **Logical OR**: `{$type=='Lookup' || $type=='Entity' ? 'complex' : 'simple'}`
- **Parentheses**: `{($type=='Text' || $type=='Integer') && $required=='true' ? 'basic' : 'other'}`
- **Nested ternary**: `{$type=='Lookup' ? ($required=='true' ? 'req' : 'opt') : 'text'}`

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

#### Enhanced Conditional Examples

**Logical Operators**:
```json
{
  "kahua.fragmentDefinitions": [{
    "id": "example",
    "name": "Example Fragment",
    "tokenReferences": ["attributes"],
    "fragments": {
    "Validation": "{$type=='Text' && $required=='true' ? 'Required=\"true\" MaxLength=\"255\"' : ''} {$type=='Integer' && $min!='' ? 'Min=\"{$min}\"' : ''}",
    "Controls": "<{$visualtype} Name=\"{$name}\" {$type=='Lookup' || $type=='Entity' ? 'Complex=\"true\"' : ''} />",
    "{($type=='Lookup' || $type=='Entity') && $category=='Advanced' ? 'ComplexControls' : ''}": "<AdvancedControl Type=\"{$type}\" />"
    }
  }]
}
```

**Nested Ternary and Parentheses**:
```json
{
  "kahua.fragmentDefinitions": [{
    "id": "example",
    "name": "Example Fragment",
    "tokenReferences": ["attributes"],
    "fragments": {
    "DisplayType": "{$type=='Lookup' ? ($visualtype=='ComboBox' ? 'dropdown' : ($visualtype=='ListBox' ? 'list' : 'other')) : 'simple'}",
    "Access": "{$category=='Public' ? 'read-write' : ($category=='Protected' ? ($required=='true' ? 'required' : 'optional') : 'admin-only')}"
    }
  }]
}
```

**Curly Braces in Literals**:
```json
{
  "kahua.fragmentDefinitions": [{
    "id": "example",
    "name": "Example Fragment",
    "tokenReferences": ["attributes"],
    "fragments": {
    "JsonConfig": "{$type=='Config' ? '{\"name\": \"{$name}\", \"type\": \"{$type}\", \"settings\": {}}' : 'null'}",
    "CssClass": "{$visualtype=='Custom' ? '.{$name}-control { display: {$display}; width: {$width}px; }' : 'default'}"
    }
  }]
}
```

#### Complete Conditional Example

**Configuration**:
```json
{
  "kahua.fragmentDefinitions": [{
    "id": "example",
    "name": "Example Fragment",
    "tokenReferences": ["attributes"],
    "fragments": {
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

### Custom Commands

The extension provides Custom commands that allow access to any fragment definition:

- **`Kahua: Generate from Custom`** - Generate output from any configured fragment
- **`Kahua: Generate Snippet for Custom`** - Create VS Code snippets for any fragment
- **`Kahua: Generate Template for Custom`** - Generate documentation templates for any fragment

These commands read from `kahua.fragmentDefinitions` and present all available fragments in a quick-pick list, making any fragment accessible without needing dedicated menu commands.

### Custom Fragments

You can add, remove, or modify fragments in your settings:

```json
{
  "kahua.fragmentDefinitions": [{
    "id": "example",
    "name": "Example Fragment",
    "tokenReferences": ["attributes"],
    "fragments": {
    "Attributes": "<Attribute Name=\"{$name}\" DataType=\"{$type}\" />",
    "CustomFragment": "<Custom Name=\"{$name}\" Entity=\"{$entity}\" Category=\"{$category}\" />",
    "ConditionalFragment": "<Element {$type=='Special' ? 'SpecialAttr=\"true\"' : ''} >{$label|friendly}</Element>",
    "{$enabled=='true' ? 'EnabledElements' : ''}": "<Enabled Name=\"{$name}\" />"
    }
  }]
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
- **Basic**: `{$tokenName}` - PascalCase (no spaces/special chars)
- **Friendly**: `{$tokenName|friendly}` - TitleCase with XML escaping
- **Internal**: `{$tokenName|internal}` - PascalCase (same as basic)
- **Uppercase**: `{$tokenName|upper}` - UPPERCASE with XML escaping
- **Lowercase**: `{$tokenName|lower}` - lowercase with XML escaping

### Conditional Expressions
- **Ternary**: `{$condition ? 'trueValue' : 'falseValue'}`
- **Equality**: `{$type=='Lookup' ? 'value' : ''}`
- **Inequality**: `{$type!='Text' ? 'value' : ''}` or `{$type<>'Text' ? 'value' : ''}`
- **Comparison**: `{$count>=5 ? 'many' : 'few'}`
- **Lists**: `{$status in ('A','B') ? 'valid' : 'invalid'}`
- **Exclusion**: `{$type not in ('X','Y') ? 'special' : 'normal'}`
- **Logical AND**: `{$type=='Text' && $required=='true' ? 'req' : 'opt'}`
- **Logical OR**: `{$type=='Lookup' || $type=='Entity' ? 'complex' : 'simple'}`
- **Parentheses**: `{($a=='X' || $b=='Y') && $c=='Z' ? 'match' : 'no'}`
- **Nested**: `{$type=='A' ? ($sub=='B' ? 'AB' : 'A') : 'other'}`

### Default Configuration
```json
{
  "kahua.suppressInvalidConditionWarnings": false,
  "kahua.showInContextMenu": true,
  "kahua.outputTarget": "newEditor",
  "kahua.showSnippetsInMenu": true,
  "kahua.showTemplatesInMenu": true,
  "kahua.tokenNameDefinitions": [
    {
      "id": "attributes",
      "name": "Attribute Tokens", 
      "type": "table",
      "tokens": "name,type,entity:Field,visualtype:TextBox,label"
    }
  ],
  "kahua.fragmentDefinitions": [
    {
      "id": "sample",
      "name": "Sample Fragment",
      "tokenReferences": ["attributes"],
      "fragments": {
        "body": "<Element Name=\"{$name}\" Type=\"{$type}\" Label=\"{$label|friendly}\" />"
      }
    }
  ]
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

To run tests:

```bash
npm test
```

The test suite includes:
- **Extension activation tests** - Verify commands are registered and configuration is valid
- **Enhanced conditional expression tests** - Test logical operators (&&, ||), parentheses, nested ternary, and curly braces in literals
- **Integration tests** - End-to-end template processing validation

To package as a VSIX (requires [`vsce`](https://github.com/microsoft/vscode-vsce)):

```bash
npm run package
```

After packaging, install the resulting `.vsix` file via the Extensions view in VS Code.

## License

MIT