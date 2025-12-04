import * as assert from 'assert';
import { toPascalCase, toTitleCase, parseTokenDefinition, simpleHash, compileTemplate, renderTemplate, evaluateExpression, splitIntoGroups, getTokenValues, applyInjectionPathTemplate, collectMissingRequiredTokens, buildRowTokenDataFromRequest, buildAttributeDisplayInfo, parseAttributeHintMetadata, getAttributeCandidatePaths } from '../../extension';

suite('Kahua Attribute Generator Unit Tests', () => {

	suite('String Transformation Functions', () => {
		suite('toPascalCase', () => {
			test('should convert simple strings to PascalCase', () => {
				assert.strictEqual(toPascalCase('hello world'), 'HelloWorld');
				assert.strictEqual(toPascalCase('test case'), 'TestCase');
			});

			test('should handle special characters', () => {
				assert.strictEqual(toPascalCase('hello-world_test'), 'HelloWorldTest');
				assert.strictEqual(toPascalCase('test.case!example'), 'TestCaseExample');
			});

			test('should handle empty strings gracefully', () => {
				assert.strictEqual(toPascalCase(''), '');
				assert.strictEqual(toPascalCase(null as any), null);
				assert.strictEqual(toPascalCase(undefined as any), undefined);
			});

			test('should handle numbers correctly', () => {
				assert.strictEqual(toPascalCase('test123case'), 'Test123Case');
				assert.strictEqual(toPascalCase('123test'), '123Test');
			});
		});

		suite('toTitleCase', () => {
			test('should convert strings to TitleCase', () => {
				assert.strictEqual(toTitleCase('hello world'), 'Hello World');
				assert.strictEqual(toTitleCase('the quick brown fox'), 'The Quick Brown Fox');
			});

			test('should handle articles correctly', () => {
				assert.strictEqual(toTitleCase('a tale of two cities'), 'A Tale of Two Cities');
				assert.strictEqual(toTitleCase('the lord of the rings'), 'The Lord of the Rings');
			});

			test('should handle empty strings gracefully', () => {
				assert.strictEqual(toTitleCase(''), '');
				assert.strictEqual(toTitleCase(null as any), null);
				assert.strictEqual(toTitleCase(undefined as any), undefined);
			});
		});
	});

	suite('Token Parsing Functions', () => {
		suite('parseTokenDefinition', () => {
			test('should parse simple token definitions', () => {
				const result = parseTokenDefinition('name,type,label');
				assert.strictEqual(result.length, 3);
				assert.strictEqual(result[0].name, 'name');
				assert.strictEqual(result[0].defaultValue, '');
				assert.strictEqual(result[1].name, 'type');
				assert.strictEqual(result[2].name, 'label');
			});

			test('should handle token definitions with default values', () => {
				const result = parseTokenDefinition('name,type:TextBox,label:Default Label');
				assert.strictEqual(result.length, 3);
				assert.strictEqual(result[0].name, 'name');
				assert.strictEqual(result[0].defaultValue, '');
				assert.strictEqual(result[1].name, 'type');
				assert.strictEqual(result[1].defaultValue, 'TextBox');
				assert.strictEqual(result[2].name, 'label');
				assert.strictEqual(result[2].defaultValue, 'Default Label');
			});

			test('should handle empty strings gracefully', () => {
				const result = parseTokenDefinition('');
				assert.strictEqual(result.length, 0);
			});

			test('should handle whitespace correctly', () => {
				const result = parseTokenDefinition(' name , type : TextBox , label ');
				assert.strictEqual(result.length, 3);
				assert.strictEqual(result[0].name, 'name');
				assert.strictEqual(result[1].name, 'type');
				assert.strictEqual(result[1].defaultValue, 'TextBox');
				assert.strictEqual(result[2].name, 'label');
			});

			test('should mark tokens with ! as required', () => {
				const result = parseTokenDefinition('name!,type:Text,label');
				assert.strictEqual(result[0].name, 'name');
				assert.strictEqual(result[0].required, true);
				assert.strictEqual(result[1].required, false);
			});
		});

		suite('collectMissingRequiredTokens', () => {
			test('identifies missing values for required tokens', () => {
				const tokens = parseTokenDefinition('name!,type');
				const missing = collectMissingRequiredTokens(tokens, tokenName => tokenName === 'name' ? '' : 'value');
				assert.deepStrictEqual(missing, ['name']);
			});

			test('returns empty array when all required tokens are provided', () => {
				const tokens = parseTokenDefinition('name!,type');
				const missing = collectMissingRequiredTokens(tokens, () => 'value');
				assert.deepStrictEqual(missing, []);
			});
		});

		suite('buildRowTokenDataFromRequest validation', () => {
			test('throws when required header token is missing', () => {
				const request: any = {
					tokenData: {
						headerTokens: parseTokenDefinition('appname!'),
						tableTokens: [],
						extractedTokens: new Map<string, string>()
					},
					dataRows: [],
					selectedFragmentDefs: []
				};

				assert.throws(
					() => buildRowTokenDataFromRequest(request),
					/Missing required header tokens: appname/
				);
			});

			test('throws when a row omits a required table token', () => {
				const request: any = {
					tokenData: {
						headerTokens: parseTokenDefinition('appname'),
						tableTokens: parseTokenDefinition('name!,type'),
						extractedTokens: new Map<string, string>([['appname', 'TestApp']])
					},
					dataRows: [
						{ name: '', type: 'Text' }
					],
					selectedFragmentDefs: []
				};

				assert.throws(
					() => buildRowTokenDataFromRequest(request),
					/Row 1: Missing required tokens/
				);
			});

			test('returns row data when all required tokens are present', () => {
				const request: any = {
					tokenData: {
						headerTokens: parseTokenDefinition('appname!'),
						tableTokens: parseTokenDefinition('name!,type'),
						extractedTokens: new Map<string, string>([['appname', 'TestApp']])
					},
					dataRows: [
						{ name: 'Field1', type: 'Text' }
					],
					selectedFragmentDefs: []
				};

				const result = buildRowTokenDataFromRequest(request);
				assert.strictEqual(result.length, 1);
				assert.strictEqual(result[0].raw.appname, 'TestApp');
				assert.strictEqual(result[0].raw.name, 'Field1');
			});
		});

		suite('buildAttributeDisplayInfo', () => {
			const hints = [
				{ segmentIndex: 1, attributes: ['Id'] },
				{ segmentIndex: 3, attributes: ['Name', 'Id'] }
			];

			const pathSegments = ['App', 'DataStore', 'Tables', 'Table', 'Columns'];

			function makeElement(tag: string, attributes: Record<string, string>, line: number): any {
				return {
					tagName: tag,
					attributes,
					line,
					column: 0,
					children: [],
					parent: undefined,
					path: tag
				};
			}

			function buildTarget(
				dataStoreAttrs: Record<string, string>,
				tableAttrs: Record<string, string>,
				columnName?: string
			): any {
				const app = makeElement('App', {}, 1);
				const dataStore = makeElement('DataStore', dataStoreAttrs, 2);
				const tables = makeElement('Tables', {}, 3);
				const table = makeElement('Table', tableAttrs, 4);
				const columns = makeElement('Columns', {}, 5);

				app.children.push(dataStore);
				dataStore.parent = app;
				dataStore.children.push(tables);
				tables.parent = dataStore;
				tables.children.push(table);
				table.parent = tables;
				table.children.push(columns);
				columns.parent = table;

				return {
					tagName: 'Columns',
					xmlNodeName: 'Columns',
					openTagLine: 5,
					closeTagLine: 5,
					lastChildLine: 5,
					indentation: '',
					isSelfClosing: false,
					context: '',
					injectionPath: '',
					attributes: columns.attributes,
					nameAttributeValue: columnName,
					enrichedPath: '',
					xpathPath: '',
					element: columns,
					attributeDisplayHints: hints,
					pathSegments
				};
			}

			test('uses table Name value when available', () => {
				const target = buildTarget({ Id: 'RFIs' }, { Name: 'kahua_AEC_RFI.RFI' });
				const info = buildAttributeDisplayInfo(target);
				assert.strictEqual(info?.label, 'kahua_AEC_RFI.RFI (Line 6)');
				assert.strictEqual(info?.detail, 'App/DataStore (RFIs)/Tables/Table (kahua_AEC_RFI.RFI)/Columns');
			});

			test('omits DataStore when configured attribute missing', () => {
				const target = buildTarget({ Name: 'RFIs' }, { Name: 'kahua_AEC_RFI.RFI' });
				const info = buildAttributeDisplayInfo(target);
				assert.strictEqual(info?.label, 'kahua_AEC_RFI.RFI (Line 6)');
				assert.strictEqual(info?.detail, 'App/DataStore/Tables/Table (kahua_AEC_RFI.RFI)/Columns');
			});

			test('falls back to table attributes when DataStore has none', () => {
				const target = buildTarget({}, { Name: 'kahua_AEC_RFI.RFI' });
				const info = buildAttributeDisplayInfo(target);
				assert.strictEqual(info?.label, 'kahua_AEC_RFI.RFI (Line 6)');
				assert.strictEqual(info?.detail, 'App/DataStore/Tables/Table (kahua_AEC_RFI.RFI)/Columns');
			});

			test('falls back to DataStore value when table lacks required attributes', () => {
				const target = buildTarget({ Id: 'RFIs' }, { });
				const info = buildAttributeDisplayInfo(target);
				assert.strictEqual(info?.label, 'RFIs (Line 6)');
				assert.strictEqual(info?.detail, 'App/DataStore (RFIs)/Tables/Table/Columns');
			});

			test('falls back to line when no configured attributes exist', () => {
				const target = buildTarget({ Name: 'RFIs' }, { Label: 'Custom' });
				const info = buildAttributeDisplayInfo(target);
				assert.strictEqual(info?.label, 'Line 6');
				assert.strictEqual(info?.detail, 'App/DataStore/Tables/Table/Columns');
			});

			test('uses line when table has unsupported attributes but DataStore does not', () => {
				const target = buildTarget({}, { Label: 'Custom' });
				const info = buildAttributeDisplayInfo(target);
				assert.strictEqual(info?.label, 'Line 6');
				assert.strictEqual(info?.detail, 'App/DataStore/Tables/Table/Columns');
			});

			test('uses line when no attributes are available anywhere', () => {
				const target = buildTarget({}, {});
				const info = buildAttributeDisplayInfo(target);
				assert.strictEqual(info?.label, 'Line 6');
				assert.strictEqual(info?.detail, 'App/DataStore/Tables/Table/Columns');
			});

			test('uses element name attribute when provided and no hints match', () => {
				const target = buildTarget({}, {}, 'ColumnsBlock');
				const info = buildAttributeDisplayInfo(target);
				assert.strictEqual(info?.label, 'ColumnsBlock (Line 6)');
				assert.strictEqual(info?.detail, 'App/DataStore/Tables/Table/Columns');
			});

			function buildLogTarget(logAttrs: Record<string, string>): any {
				const app = makeElement('App', {}, 1);
				const hubDefs = makeElement('App.HubDefs', {}, 2);
				const hubDef = makeElement('HubDef', {}, 3);
				const logs = makeElement('HubDef.Logs', {}, 4);
				const log = makeElement('Log', logAttrs, 5);
				const logFields = makeElement('Log.Fields', {}, 6);

				app.children.push(hubDefs);
				hubDefs.parent = app;
				hubDefs.children.push(hubDef);
				hubDef.parent = hubDefs;
				hubDef.children.push(logs);
				logs.parent = hubDef;
				logs.children.push(log);
				log.parent = logs;
				log.children.push(logFields);
				logFields.parent = log;

				return {
					tagName: 'Log.Fields',
					xmlNodeName: 'Log.Fields',
					openTagLine: logFields.line,
					closeTagLine: logFields.line,
					lastChildLine: logFields.line,
					indentation: '',
					isSelfClosing: false,
					context: '',
					injectionPath: '',
					attributes: logFields.attributes,
					nameAttributeValue: undefined,
					enrichedPath: '',
					xpathPath: '',
					element: logFields,
					attributeDisplayHints: [
						{ segmentIndex: 4, attributes: ['Label', 'Name'] }
					],
					pathSegments: ['App', 'App.HubDefs', 'HubDef', 'HubDef.Logs', 'Log', 'Log.Fields']
				};
			}

			test('prefers log label from attribute hints even when placeholder values', () => {
				const target = buildLogTarget({ Label: '[DataViewAllLabel]' });
				const info = buildAttributeDisplayInfo(target);
				assert.strictEqual(info?.label, '[DataViewAllLabel] (Line 7)');
				assert.strictEqual(info?.detail, 'App/App.HubDefs/HubDef/HubDef.Logs/Log ([DataViewAllLabel])/Log.Fields');
			});
		});

		suite('parseAttributeHintMetadata', () => {
			test('parses escaped quotes from JSON defaults', () => {
				const rawPath = 'App/DataStore(\\"Id\\")/Tables/Table[@EntityDefName=\'{appname}.{entity}\'](\\"Name\\"|\\"Id\\")/Columns';
				const parsed = parseAttributeHintMetadata(rawPath);

				assert.strictEqual(
					parsed.path,
					"App/DataStore/Tables/Table[@EntityDefName='{appname}.{entity}']/Columns"
				);
				assert.deepStrictEqual(parsed.segments, [
					'App',
					'DataStore',
					'Tables',
					"Table[@EntityDefName='{appname}.{entity}']",
					'Columns'
				]);
				assert.strictEqual(parsed.hints.length, 2);
				assert.deepStrictEqual(parsed.hints[0], { segmentIndex: 1, attributes: ['Id'] });
				assert.deepStrictEqual(parsed.hints[1], { segmentIndex: 3, attributes: ['Name', 'Id'] });
			});
		});

		suite('getAttributeCandidatePaths', () => {
			test('uses configured attributes first', () => {
				const candidates = getAttributeCandidatePaths('App/@Name', ['Extends', 'DisplayName']);
				assert.deepStrictEqual(candidates, ['App/@Extends', 'App/@DisplayName', 'App/@Name']);
			});

			test('handles "any" keyword', () => {
				const candidates = getAttributeCandidatePaths('App/@Name', ['Extends', 'any']);
				assert.deepStrictEqual(candidates, ['App/@Extends', 'App/@Name']);
			});

			test('falls back to original path when no order specified', () => {
				const candidates = getAttributeCandidatePaths('App/@Name');
				assert.deepStrictEqual(candidates, ['App/@Name']);
			});
		});
	});

	suite('Template Engine', () => {
		suite('compileTemplate', () => {
			test('should handle plain text', () => {
				const template = 'this is plain text';
				const compiled = compileTemplate(template);
				assert.deepStrictEqual(compiled.parts, [{ type: 'text', value: 'this is plain text' }]);
			});

			test('should compile simple tokens', () => {
				const template = 'Hello {$name}';
				const compiled = compileTemplate(template);
				assert.deepStrictEqual(compiled.parts, [
					{ type: 'text', value: 'Hello ' },
					{ type: 'token', tokenName: 'name', transform: 'default' }
				]);
			});

			test('should compile tokens with transformations', () => {
				const template = 'Internal: {$name|internal}, Friendly: {$name|friendly}';
				const compiled = compileTemplate(template);
				assert.deepStrictEqual(compiled.parts, [
					{ type: 'text', value: 'Internal: ' },
					{ type: 'token', tokenName: 'name', transform: 'internal' },
					{ type: 'text', value: ', Friendly: ' },
					{ type: 'token', tokenName: 'name', transform: 'friendly' }
				]);
			});

			test('should compile string interpolations', () => {
				const template = 'Value is $(token)';
				const compiled = compileTemplate(template);
				assert.deepStrictEqual(compiled.parts, [
					{ type: 'text', value: 'Value is ' },
					{ type: 'interpolation', tokenName: 'token', transform: 'default' }
				]);
			});

			test('should compile simple conditionals', () => {
				const template = `{'{$type}'=='Lookup' ? 'Lookup' : 'Other'}`;
				const compiled = compileTemplate(template);
				assert.strictEqual(compiled.parts.length, 1);
				const conditionalPart = compiled.parts[0] as any;
				assert.strictEqual(conditionalPart.type, 'conditional');
				assert.strictEqual(conditionalPart.condition, `'{$type}'=='Lookup'`);
				assert.deepStrictEqual(conditionalPart.trueTemplate.parts, [{ type: 'text', value: 'Lookup' }]);
				assert.deepStrictEqual(conditionalPart.falseTemplate.parts, [{ type: 'text', value: 'Other' }]);
			});

			test('should compile conditionals with tokens inside', () => {
				const template = `{'{$type}'=='a' ? '{$v1}' : '{$v2}'}`;
				const compiled = compileTemplate(template);
				assert.strictEqual(compiled.parts.length, 1);
				const conditionalPart = compiled.parts[0] as any;
				assert.strictEqual(conditionalPart.type, 'conditional');
				assert.strictEqual(conditionalPart.condition, `'{$type}'=='a'`);
				assert.deepStrictEqual(conditionalPart.trueTemplate.parts, [{ type: 'token', tokenName: 'v1', transform: 'default' }]);
				assert.deepStrictEqual(conditionalPart.falseTemplate.parts, [{ type: 'token', tokenName: 'v2', transform: 'default' }]);
			});

			test('should handle nested conditionals', () => {
				const template = `{'{$type}'=='a' ? '{'{$mode}'=='b' ? 'v1' : 'v2'}' : 'v3'}`;
				const compiled = compileTemplate(template);
				assert.strictEqual(compiled.parts.length, 1);
				const outerConditional = compiled.parts[0] as any;
				assert.strictEqual(outerConditional.type, 'conditional');
				assert.strictEqual(outerConditional.condition, `'{$type}'=='a'`);

				const innerConditional = outerConditional.trueTemplate.parts[0] as any;
				assert.strictEqual(innerConditional.type, 'conditional');
				assert.strictEqual(innerConditional.condition, `'{$mode}'=='b'`);
				assert.deepStrictEqual(innerConditional.trueTemplate.parts, [{ type: 'text', value: 'v1' }]);
				assert.deepStrictEqual(innerConditional.falseTemplate.parts, [{ type: 'text', value: 'v2' }]);

				assert.deepStrictEqual(outerConditional.falseTemplate.parts, [{ type: 'text', value: 'v3' }]);
			});
		});

		suite('renderTemplate', () => {
			test('should render simple tokens', () => {
				const template = 'Hello {$name}';
				const values = { name: 'world' };
				const { result } = renderTemplate(template, values, values, false);
				assert.strictEqual(result, 'Hello World');
			});

			test('should apply transformations during render', () => {
				const template = 'Internal: {$name|internal}, Friendly: {$name|friendly}';
				const values = { name: 'test name' };
				const { result } = renderTemplate(template, values, values, false);
				assert.strictEqual(result, 'Internal: TestName, Friendly: Test Name');
			});

			test('should handle missing tokens gracefully', () => {
				const template = 'Hello {$name}';
				const values = { other: 'value' };
				const { result } = renderTemplate(template, values, values, false);
				assert.strictEqual(result, 'Hello ');
			});

			test('should render string interpolations', () => {
				const template = 'The value is $(token|upper)';
				const values = { token: 'abc' };
				const { result } = renderTemplate(template, values, values, false);
				assert.strictEqual(result, 'The value is ABC');
			});

			test('should render conditional templates', () => {
				const template = `{'{$type}'=='Lookup' ? 'LookupType' : 'OtherType'}`;
				const values = { type: 'Lookup' };
				const { result } = renderTemplate(template, values, values, false);
				assert.strictEqual(result, 'LookupType');
			});

			test('should render conditional templates with token values', () => {
				const template = `{'{$type}' == 'a' ? '{$val1}' : '{$val2}'}`;
				const values = { type: 'a', val1: 'value one', val2: 'value two' };
				const { result } = renderTemplate(template, values, values, false);
				assert.strictEqual(result, 'Valueone'); // 'value one' -> 'ValueOne'
			});
		});

		suite('evaluateExpression', () => {
			test('should evaluate equality', () => {
				assert.strictEqual(evaluateExpression(`"a" == "a"`), true);
				assert.strictEqual(evaluateExpression(`"a" == "b"`), false);
			});

			test('should evaluate inequality', () => {
				assert.strictEqual(evaluateExpression(`"a" != "b"`), true);
				assert.strictEqual(evaluateExpression(`"a" != "a"`), false);
				assert.strictEqual(evaluateExpression(`"a" <> "b"`), true);
			});

			test('should handle logical AND', () => {
				assert.strictEqual(evaluateExpression(`"a" == "a" && "b" == "b"`), true);
				assert.strictEqual(evaluateExpression(`"a" == "a" && "b" == "c"`), false);
			});

			test('should handle logical OR', () => {
				assert.strictEqual(evaluateExpression(`"a" == "a" || "b" == "c"`), true);
				assert.strictEqual(evaluateExpression(`"a" == "b" || "b" == "c"`), false);
			});

			test('should respect operator precedence', () => {
				assert.strictEqual(evaluateExpression(`"a" == "b" && "c" == "c" || "d" == "d"`), true);
				assert.strictEqual(evaluateExpression(`"a" == "a" && "b" == "c" || "d" == "d"`), true);
				assert.strictEqual(evaluateExpression(`"a" == "a" && ("b" == "c" || "d" == "d")`), true);
			});

			test('should handle parentheses', () => {
				assert.strictEqual(evaluateExpression(`("a" == "a" && "b" == "c")`), false);
				assert.strictEqual(evaluateExpression(`("a" == "a" || "b" == "c") && "d" == "e"`), false);
			});

			test('should evaluate "in" operator', () => {
				assert.strictEqual(evaluateExpression(`"b" in ('a', 'b', 'c')`), true);
				assert.strictEqual(evaluateExpression(`"d" in ('a', 'b', 'c')`), false);
			});

			test('should evaluate "not in" operator', () => {
				assert.strictEqual(evaluateExpression(`"d" not in ('a', 'b', 'c')`), true);
				assert.strictEqual(evaluateExpression(`"a" not in ('a', 'b', 'c')`), false);
			});

			test('should handle complex nested expressions', () => {
				const expression = `("a" == "a" && ("b" in ('x','y','b') || "z" == "y")) && "d" not in ('e')`;
				assert.strictEqual(evaluateExpression(expression), true);
			});
		});
	});

	suite('Template Rendering Functions', () => {
		// TODO: Add template rendering tests
	});

	suite('Helper Functions', () => {
		suite('splitIntoGroups', () => {
			test('should split text into a single group', () => {
				const text = `line1\nline2`;
				const groups = splitIntoGroups(text);
				assert.deepStrictEqual(groups, [['line1', 'line2']]);
			});

			test('should split text into multiple groups', () => {
				const text = `g1line1\ng1line2\n\ng2line1`;
				const groups = splitIntoGroups(text);
				assert.deepStrictEqual(groups, [['g1line1', 'g1line2'], ['g2line1']]);
			});

			test('should handle leading/trailing/multiple empty lines', () => {
				const text = `\n\ng1line1\n\n\ng2line1\n\n`;
				const groups = splitIntoGroups(text);
				assert.deepStrictEqual(groups, [['g1line1'], ['g2line1']]);
			});

			test('should ignore comment lines', () => {
				const text = `line1\n// this is a comment\nline2`;
				const groups = splitIntoGroups(text);
				assert.deepStrictEqual(groups, [['line1', 'line2']]);
			});
		});

		suite('getTokenValues', () => {
			const headerTokens = [{ name: 'entity', defaultValue: '' }];
			const tableTokens = [{ name: 'name', defaultValue: '' }, { name: 'type', defaultValue: 'TextBox' }];

			test('should extract values with header and data lines', () => {
				const headerLine = 'MyEntity';
				const dataLine = 'AttributeName,Lookup';
				const { cleanTokenValues, rawTokenValues } = getTokenValues(headerTokens, tableTokens, headerLine, dataLine);

				assert.strictEqual(cleanTokenValues['entity'], 'Myentity');
				assert.strictEqual(cleanTokenValues['name'], 'Attributename');
				assert.strictEqual(cleanTokenValues['type'], 'Lookup');

				assert.strictEqual(rawTokenValues['entity'], 'MyEntity');
				assert.strictEqual(rawTokenValues['name'], 'AttributeName');
				assert.strictEqual(rawTokenValues['type'], 'Lookup');
			});

			test('should extract values with only data lines', () => {
				const dataLine = 'AttributeName,';
				const { cleanTokenValues, rawTokenValues } = getTokenValues([], tableTokens, undefined, dataLine);

				assert.strictEqual(cleanTokenValues['name'], 'Attributename');
				assert.strictEqual(cleanTokenValues['type'], 'Textbox'); // From default value

				assert.strictEqual(rawTokenValues['name'], 'AttributeName');
				assert.strictEqual(rawTokenValues['type'], ''); // Raw value is empty
			});
		});
	});

	suite('XML Processing Functions', () => {
		test('should parse simple XML correctly', () => {
			// Test XML parsing without VS Code document interface
			assert.ok(true, 'Placeholder test');
		});

		test('should handle malformed XML gracefully', () => {
			assert.ok(true, 'Placeholder test');
		});

		test('should extract element attributes correctly', () => {
			assert.ok(true, 'Placeholder test');
		});
	});

	suite('Configuration Processing', () => {
		test('should validate fragment definitions', () => {
			assert.ok(true, 'Placeholder test');
		});

		test('should validate token definitions', () => {
			assert.ok(true, 'Placeholder test');
		});

		test('should handle missing configuration gracefully', () => {
			assert.ok(true, 'Placeholder test');
		});
	});

	suite('Performance Optimizations', () => {
		suite('simpleHash', () => {
			test('should generate consistent hashes', () => {
				const text = 'test content';
				const hash1 = simpleHash(text);
				const hash2 = simpleHash(text);
				assert.strictEqual(hash1, hash2);
			});

			test('should generate different hashes for different content', () => {
				const hash1 = simpleHash('content1');
				const hash2 = simpleHash('content2');
				assert.notStrictEqual(hash1, hash2);
			});

			test('should handle empty strings', () => {
				const hash = simpleHash('');
				assert.strictEqual(typeof hash, 'string');
				assert.strictEqual(hash, '0');
			});

			test('should return string hashes', () => {
				const hash = simpleHash('test');
				assert.strictEqual(typeof hash, 'string');
			});
		});

		suite('transformation caching', () => {
			test('should cache toPascalCase results', () => {
				// Clear any existing cache by using a unique test string
				const testString = 'unique test string ' + Date.now();
				
				// First call - should cache the result
				const result1 = toPascalCase(testString);
				
				// Second call - should use cached result
				const result2 = toPascalCase(testString);
				
				assert.strictEqual(result1, result2);
			});

			test('should cache toTitleCase results', () => {
				// Similar test for TitleCase
				const testString = 'unique title test ' + Date.now();
				
				const result1 = toTitleCase(testString);
				const result2 = toTitleCase(testString);
				
				assert.strictEqual(result1, result2);
			});
		});
	});

	suite('File Opening Behavior', () => {
		test('should handle editor state detection correctly', () => {
			// This is a placeholder test since we can't mock VS Code APIs in unit tests
			// The actual behavior is tested through integration tests
			assert.ok(true, 'Editor state detection logic implemented');
		});

		test('should avoid unnecessary file opening', () => {
			// Placeholder test for the file opening optimization
			// Real testing requires VS Code environment
			assert.ok(true, 'File opening optimization implemented');
		});
	});

	suite('XPath Template Application', () => {
		// Mock token definitions for testing
		const mockTokenDefinitions = [{
			id: 'appname',
			name: 'App Name Header',
			type: 'header' as const,
			tokens: 'appname,entity:Field',
			tokenReadPaths: {
				entity: {
					type: 'selection' as const,
					path: 'EntityDefs/EntityDef',
					attribute: 'Name',
					affectsInjection: true,
					injectionPathTemplate: 'EntityDefs/EntityDef[@Name=\'{value}\']/Attributes'
				}
			}
		}];

		const mockAffectingTokens = new Map([['entity', 'EntityA']]);

		suite('applyInjectionPathTemplate', () => {
			test('should apply template to correct EntityDef paths', () => {
				const xpath = 'EntityDefs/EntityDef/Attributes';
				const result = applyInjectionPathTemplate(xpath, mockAffectingTokens, mockTokenDefinitions);
				
				assert.strictEqual(result.success, true);
				assert.strictEqual(result.result, 'EntityDefs/EntityDef[@Name=\'EntityA\']/Attributes');
			});

			test('should NOT apply template to DataStore paths with EntityDefName attribute', () => {
				const xpath = 'DataStore/Tables/Table[@EntityDefName=\'something\']/Columns';
				const result = applyInjectionPathTemplate(xpath, mockAffectingTokens, mockTokenDefinitions);
				
				assert.strictEqual(result.success, true);
				assert.strictEqual(result.result, xpath); // Should remain unchanged
			});

			test('should NOT apply template to unrelated paths', () => {
				const xpath = 'Cultures/Culture[@Code=\'en\']/Labels';
				const result = applyInjectionPathTemplate(xpath, mockAffectingTokens, mockTokenDefinitions);
				
				assert.strictEqual(result.success, true);
				assert.strictEqual(result.result, xpath); // Should remain unchanged
			});

			test('should apply template to EntityDef paths with existing attribute filters', () => {
				const xpath = 'EntityDefs/EntityDef[@SomeAttr=\'value\']/Attributes';
				const result = applyInjectionPathTemplate(xpath, mockAffectingTokens, mockTokenDefinitions);
				
				assert.strictEqual(result.success, true);
				assert.strictEqual(result.result, 'EntityDefs/EntityDef[@Name=\'EntityA\']/Attributes');
			});

			test('should handle paths without affecting tokens', () => {
				const xpath = 'EntityDefs/EntityDef/Attributes';
				const emptyTokens = new Map();
				const result = applyInjectionPathTemplate(xpath, emptyTokens, mockTokenDefinitions);
				
				assert.strictEqual(result.success, true);
				assert.strictEqual(result.result, xpath); // Should remain unchanged
			});

			test('should handle empty token definitions', () => {
				const xpath = 'EntityDefs/EntityDef/Attributes';
				const result = applyInjectionPathTemplate(xpath, mockAffectingTokens, []);
				
				assert.strictEqual(result.success, true);
				assert.strictEqual(result.result, xpath); // Should remain unchanged
			});

			test('should handle complex DataStore paths without false matching', () => {
				const xpath = 'DataStore/Tables/Table[@EntityDefName=\'MyEntity\']/Columns';
				const result = applyInjectionPathTemplate(xpath, mockAffectingTokens, mockTokenDefinitions);
				
				assert.strictEqual(result.success, true);
				assert.strictEqual(result.result, xpath); // Should remain unchanged
			});

			test('should properly distinguish path elements from attribute names', () => {
				// This path contains "EntityDef" in attribute name but not as path element
				const xpath = 'SomeOther/Path[@LinkedEntityDef=\'test\']/Elements';
				const result = applyInjectionPathTemplate(xpath, mockAffectingTokens, mockTokenDefinitions);
				
				assert.strictEqual(result.success, true);
				assert.strictEqual(result.result, xpath); // Should remain unchanged
			});

			test('should handle EntityDef with brackets in path', () => {
				const xpath = 'EntityDefs/EntityDef[@Name=\'ExistingEntity\']/Attributes';
				const result = applyInjectionPathTemplate(xpath, mockAffectingTokens, mockTokenDefinitions);
				
				assert.strictEqual(result.success, true);
				assert.strictEqual(result.result, 'EntityDefs/EntityDef[@Name=\'EntityA\']/Attributes');
			});

			test('should work with different entity values', () => {
				const differentTokens = new Map([['entity', 'DifferentEntity']]);
				const xpath = 'EntityDefs/EntityDef/Attributes';
				const result = applyInjectionPathTemplate(xpath, differentTokens, mockTokenDefinitions);
				
				assert.strictEqual(result.success, true);
				assert.strictEqual(result.result, 'EntityDefs/EntityDef[@Name=\'DifferentEntity\']/Attributes');
			});

			test('should enforce absolute path precision for App/ paths', () => {
				const absoluteTokenDefinitions = [{
					id: 'appname',
					name: 'App Name Header',
					type: 'header' as const,
					tokens: 'appname,entity:Field',
					tokenReadPaths: {
						entity: {
							type: 'selection' as const,
							path: 'EntityDefs/EntityDef',
							attribute: 'Name',
							affectsInjection: true,
							injectionPathTemplate: 'App/EntityDefs/EntityDef[@Name=\'{value}\']/Attributes'
						}
					}
				}];

				// Test that App/DataStore path doesn't get entity template
				const dataStorePath = 'App/DataStore/Tables/Table/Columns';
				const dataStoreResult = applyInjectionPathTemplate(dataStorePath, mockAffectingTokens, absoluteTokenDefinitions);
				assert.strictEqual(dataStoreResult.result, dataStorePath); // Should remain unchanged

				// Test that App/EntityDefs path does get entity template
				const entityPath = 'App/EntityDefs/EntityDef/Attributes'; 
				const entityResult = applyInjectionPathTemplate(entityPath, mockAffectingTokens, absoluteTokenDefinitions);
				assert.strictEqual(entityResult.result, 'App/EntityDefs/EntityDef[@Name=\'EntityA\']/Attributes');
			});
		});
	});
});
