# Kahua Attribute Generator

Generate XML attribute definitions for Kahua apps or supplements directly from selected text in Visual Studio Code.

## Features

* **Two generation modes** via Command Palette or context menu:

  * **`Kahua: Generate Extension Attributes from Selection`** – Uses `kahua.defaultPrefix.extension` setting
  * **`Kahua: Generate Supplement Attributes from Selection`** – Uses `kahua.defaultPrefix.supplement` setting

* **Configurable token system** – Define your own token names and default values via `kahua.tokenNameDefinitions`

* **Customizable XML fragments** – Modify, add, or remove output fragments via `kahua.fragmentDefinitions` setting

* **Grouped fragments with multiple outputs** – Each fragment definition can contain multiple *groups* (`primary`, `secondary`, etc.), each with its own `header`, `body`, and `footer`.

* **Flexible transformations** – PascalCase for identifiers, TitleCase for display text, plus uppercase/lowercase options

* **Conditional blocks** – Generate dynamic XML with conditional expressions based on token values

* **Advanced token syntax** – Support for `{$token}` prefixing and conditional expressions (`{$condition ? 'value' : 'fallback'}`)

* **Multiple output options** – Copy to clipboard or open in new editor window

* **Comprehensive validation** – Clear error messages for configuration and input issues

* **Token value table** – Shows token assignments for each processed line in output

## Usage

1. Install the extension via the VSIX package or clone this repository and run `npm install` followed by `vsce package` to build a VSIX.

2. Select one or more lines of text in your editor. Each line should contain comma-separated values corresponding to your configured tokens:

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

| Setting                                  | Default                       | Description                                                                        |
| ---------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------- |
| `kahua.showInContextMenu`                | `true`                        | Show Kahua generator commands in the editor right-click context menu               |
| `kahua.outputTarget`                     | `"newEditor"`                 | Choose where to output generated XML: `"clipboard"` or `"newEditor"`               |
| `kahua.tokenNameDefinitions`             | Array of token definitions    | Define token sets with ID, name, type, and token list                              |
| `kahua.suppressInvalidConditionWarnings` | `false`                       | Suppress error notifications when conditional expressions reference invalid tokens |
| `kahua.fragmentDefinitions`              | Array of fragment definitions | Define reusable fragment templates with conditional support                        |

## Token Configuration

### Token Name Definitions

The extension uses a flexible token definition system via `kahua.tokenNameDefinitions`. Each definition specifies:

* **id**: Unique identifier
* **name**: Display name
* **type**: Either "header" (single line) or "table" (row-by-row)
* **tokens**: Comma-separated token names with optional defaults

**Input format**: Each selected line should contain comma-separated values corresponding to your configured tokens:

* `FieldName` - Uses defaults for all missing tokens
* `FieldName,MyEntity` - Provides name and entity, uses defaults for type, label, visualtype
* `FieldName,MyEntity,Integer` - Provides name, entity, and type
* `FieldName,MyEntity,Integer,Friendly Name` - Provides all except visualtype (uses TextBox default)
* `FieldName,MyEntity,Integer,Friendly Name,ComboBox` - Provides all tokens

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

| Input                                              | Result                                                                                               |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `FieldA`                                           | `name=FieldA, entity=, type=Text, label=, visualtype=TextBox, category=Standard`                     |
| `FieldA,MyEntity`                                  | `name=FieldA, entity=MyEntity, type=Text, label=, visualtype=TextBox, category=Standard`             |
| `FieldA,MyEntity,Integer`                          | `name=FieldA, entity=MyEntity, type=Integer, label=, visualtype=TextBox, category=Standard`          |
| `FieldA,MyEntity,,Custom Label`                    | `name=FieldA, entity=MyEntity, type=Text, label=Custom Label, visualtype=TextBox, category=Standard` |
| `FieldA,MyEntity,Lookup,Field A,ComboBox,Advanced` | `name=FieldA, entity=MyEntity, type=Lookup, label=Field A, visualtype=ComboBox, category=Advanced`   |

---

## Fragment System

### Grouped Fragments

Fragments are grouped under keys (`primary`, `secondary`, …). Each group may define `header`, `body`, and `footer`. Groups are output independently, and each group’s output is preceded by a comment showing its name.

#### Example: Lookup Lists with Secondary Labels

```jsonc
{
  "id": "lookups",
  "name": "Lookup Lists",
  "type": "table",
  "tokenReferences": ["lookupheader","lookups"],
  "fragments": {
    "primary": {
      "header": "<LookupList Name=\"{$entity}_{$listname}LookupList\" Label=\"{$entity}_{$listname}LookupListLabel\" Description=\"{$entity}_{$listname}LookupListDescription\">",
      "body": "<Value Label=\"[{$label != '' ? '{$label}' : '{$entity}_{$listname}{$value|title}Label'}]\">{$value|friendly}</Value>",
      "footer": "</LookupList>"
    },
    "secondary": {
      "header": "<Label Key=\"{$entity}_{$listname}LookupListLabel\">{$listlabel != '' ? $listlabel|friendly : $listname|friendly}</Label>\n<Label Key=\"{$entity}_{$listname}LookupListDescription\">{$listdescription != '' ? $listdescription : $listname|friendly}</Label>",
      "body": "<Label Key=\"{$label != '' ? '{$label}' : '{$entity}_{$listname}{$value|title}Label'}\">{$label != '' ? $label|friendly : $value|friendly}</Label>"
    }
  }
}
```

This produces both the `<LookupList>` with `<Value>`s (**primary**) and a set of `<Label>` elements (**secondary**) for the list and each value.

---

### Token Syntax and Transformations

Fragments support the `{$token}` syntax with transformation options:

* **`{$token}`** – Default: PascalCase (capitalizes words, strips spaces/special chars)
* **`{$token|internal}`** – Explicit PascalCase
* **`{$token|friendly}`** – TitleCase with XML escaping
* **`{$token|upper}`** – Uppercase with XML escaping
* **`{$token|lower}`** – Lowercase with XML escaping

---

### Conditional Blocks

Fragments can include conditional expressions:

```
{$condition ? 'trueValue' : 'falseValue'}
```

Supported operators: `==`, `!=`, `<>`, `<=`, `>=`, `in (...)`, `not in (...)`, `&&`, `||`, parentheses, and nested ternary operators.

---

## Quick Reference

### Token Syntax

* **Basic**: `{$tokenName}` – PascalCase
* **Friendly**: `{$tokenName|friendly}` – TitleCase with XML escaping
* **Internal**: `{$tokenName|internal}` – PascalCase
* **Uppercase**: `{$tokenName|upper}` – UPPERCASE with XML escaping
* **Lowercase**: `{$tokenName|lower}` – lowercase with XML escaping

### Conditional Expressions

* **Ternary**: `{$condition ? 'true' : 'false'}`
* **Equality**: `{$type=='Lookup' ? 'yes' : 'no'}`
* **Inequality**: `{$type!='Text' ? 'x' : 'y'}`
* **Comparison**: `{$count>=5 ? 'many' : 'few'}`
* **Lists**: `{$status in ('A','B') ? 'valid' : 'invalid'}`
* **Exclusion**: `{$type not in ('X','Y') ? 'special' : 'normal'}`
* **Logical AND**: `{$a=='1' && $b=='2' ? 'yes' : 'no'}`
* **Logical OR**: `{$a=='1' || $b=='2' ? 'yes' : 'no'}`
* **Nested**: `{$x=='A' ? ($y=='B' ? 'AB' : 'A') : 'other'}`

---

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

To package as a VSIX (requires [`vsce`](https://github.com/microsoft/vscode-vsce)):

```bash
npm run package
```

After packaging, install the resulting `.vsix` file via the Extensions view in VS Code.

## License

MIT

