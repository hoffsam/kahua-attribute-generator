# Kahua Attribute Generator

Generate XML attribute definitions for Kahua apps or supplements directly from selected text in Visual Studio Code.

## Features

* Provides two commands via the Command Palette:
  * **`Kahua: Create Attributes From Selection For Extension`** – uses the `kahua.defaultPrefix.extension` setting to build attribute names and tokens.
  * **`Kahua: Create Attributes From Selection For Supplement`** – uses the `kahua.defaultPrefix.supplement` setting instead.

* Accepts multiple selected lines and turns each into five related XML fragments:
  * An `<Attribute/>` definition with label and description tokens.
  * A `<Label/>` entry referencing the generated key and value.
  * A `<DataTag/>` to provide metadata.
  * A `<Field/>` definition for a datastore.
  * A `<FieldDef/>` connecting the attribute to the data tag.

* Supports user‑definable templates for token formats under the `kahua.tokens.*` namespace in your settings.

* Copies the generated XML to your clipboard and notifies you when ready.

## Usage

1. Install the extension via the VSIX package or clone this repository and run `npm install` followed by `vsce package` to build a VSIX.
2. Select one or more lines of text in your editor. Each line may contain a comma‑separated list:

   * **`AttributeName`** – just the attribute name. The generator will derive a prefix from the first `<EntityDef Name="…">` in the current document and default the data type to `Text`.
   * **`AttributeName,Prefix`** – specify both the attribute name and a custom prefix. The data type again defaults to `Text`.
   * **`AttributeName,Prefix,DataType`** – specify the attribute name, a custom prefix and an explicit data type.

   Whitespace around commas is ignored. Names are sanitized to remove non‑alphanumeric characters.

3. Open the Command Palette (`Ctrl+Shift+P` / `⌘⇧P`) and run **`Kahua: Create Attributes From Selection For Extension`** or **`…For Supplement`** depending on your context.
4. The generated XML snippets are copied to your clipboard. Paste them wherever you need them.

## Configuration

You can override the following settings in your workspace or user `settings.json`:

| Setting | Default | Description |
| --- | --- | --- |
| `kahua.tokens.attributeLabelFormat` | `[{prefix}_{name}Label]` | How to format the label token. `{prefix}` becomes the configured prefix, `{name}` becomes the sanitized attribute name. |
| `kahua.tokens.attributeDescriptionFormat` | `[{prefix}_{name}Description]` | How to format the description token. |
| `kahua.tokens.dataTagNameFormat` | `{prefix}_{name}` | How to format the DataTag name. |
| `kahua.tokens.labelKeyFormat` | `{prefix}_{name}Label` | The key used for each `<Label/>`. |
| `kahua.tokens.labelValueFormat` | `{label}` | The value placed inside each `<Label/>`. `{label}` represents the original selected line. |
| `kahua.defaultPrefix.extension` | empty string | Default prefix when generating app‑style attributes. |
| `kahua.defaultPrefix.supplement` | `Inspections` | Default prefix when generating supplement‑style attributes. |

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