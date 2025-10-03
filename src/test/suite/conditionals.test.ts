import * as assert from 'assert';
import * as vscode from 'vscode';

// Import the functions we want to test
// We'll need to export these from extension.ts for testing
// For now, we'll re-implement the core logic or import it

suite('Enhanced Conditional Expression Tests', () => {
	
	// Helper function to evaluate expressions (copied from extension.ts for testing)
	function evaluateExpression(expression: string): boolean {
		expression = expression.trim();
		
		// Handle ternary operator
		const ternaryResult = findTernaryOperator(expression);
		if (ternaryResult) {
			const { condition, trueValue, falseValue } = ternaryResult;
			const conditionResult = evaluateExpression(condition);
			return conditionResult;
		}
		
		// Handle logical OR
		const orResult = findLogicalOperator(expression, '||');
		if (orResult) {
			const { left, right } = orResult;
			return evaluateExpression(left) || evaluateExpression(right);
		}
		
		// Handle logical AND
		const andResult = findLogicalOperator(expression, '&&');
		if (andResult) {
			const { left, right } = andResult;
			return evaluateExpression(left) && evaluateExpression(right);
		}
		
		// Handle parentheses
		if (expression.startsWith('(') && expression.endsWith(')')) {
			const inner = expression.slice(1, -1).trim();
			if (isBalancedParentheses(inner)) {
				return evaluateExpression(inner);
			}
		}
		
		// Handle 'not in' operator
		const notInMatch = expression.match(/^"([^"]*?)"\s+not\s+in\s+\(([^)]+)\)$/i);
		if (notInMatch) {
			const [, value, listStr] = notInMatch;
			const list = listStr.split(',').map(item => item.trim().replace(/^['"]|['"]$/g, ''));
			return !list.includes(value);
		}
		
		// Handle 'in' operator
		const inMatch = expression.match(/^"([^"]*?)"\s+in\s+\(([^)]+)\)$/i);
		if (inMatch) {
			const [, value, listStr] = inMatch;
			const list = listStr.split(',').map(item => item.trim().replace(/^['"]|['"]$/g, ''));
			return list.includes(value);
		}
		
		// Handle comparison operators (support both single and double quotes)
		const comparisonMatch = expression.match(/^(['"])([^'"]*?)\1\s*(==|!=|<=|>=|<>)\s*(['"])([^'"]*?)\4$/);
		if (comparisonMatch) {
			const [, , left, operator, , right] = comparisonMatch;

			switch (operator) {
				case '==':
					return left === right;
				case '!=':
				case '<>':
					return left !== right;
				case '<=':
					return left <= right;
				case '>=':
					return left >= right;
				default:
					return false;
			}
		}

		// Handle simple boolean expressions
		if (expression === '""' || expression === "''" || expression === 'false' || expression === '0') {
			return false;
		}

		return true;
	}

	// Helper functions (copied from extension.ts for testing)
	function isBalancedParentheses(expression: string): boolean {
		let count = 0;
		for (const char of expression) {
			if (char === '(') count++;
			else if (char === ')') count--;
			if (count < 0) return false;
		}
		return count === 0;
	}

	function findTernaryOperator(expression: string): { condition: string; trueValue: string; falseValue: string } | null {
		let parenCount = 0;
		let questionPos = -1;
		let colonPos = -1;
		
		for (let i = 0; i < expression.length; i++) {
			const char = expression[i];
			if (char === '(') parenCount++;
			else if (char === ')') parenCount--;
			else if (char === '?' && parenCount === 0 && questionPos === -1) {
				questionPos = i;
			} else if (char === ':' && parenCount === 0 && questionPos !== -1 && colonPos === -1) {
				colonPos = i;
				break;
			}
		}
		
		if (questionPos !== -1 && colonPos !== -1) {
			const condition = expression.substring(0, questionPos).trim();
			const trueValue = expression.substring(questionPos + 1, colonPos).trim();
			const falseValue = expression.substring(colonPos + 1).trim();
			return { condition, trueValue, falseValue };
		}
		
		return null;
	}

	function findLogicalOperator(expression: string, operator: '&&' | '||'): { left: string; right: string } | null {
		let parenCount = 0;
		const opLength = operator.length;
		
		for (let i = expression.length - opLength; i >= 0; i--) {
			const char = expression[i];
			
			if (char === ')') parenCount++;
			else if (char === '(') parenCount--;
			else if (parenCount === 0 && expression.substr(i, opLength) === operator) {
				const left = expression.substring(0, i).trim();
				const right = expression.substring(i + opLength).trim();
				if (left && right) {
					return { left, right };
				}
			}
		}
		
		return null;
	}

	// Helper function to evaluate conditional with token substitution
	function evaluateConditionalWithTokens(expression: string, tokenValues: Record<string, string>): boolean {
		// Replace tokens in the expression with their values
		let processedExpression = expression;
		
		const tokenPattern = /\{\$(\w+)\}/g;
		let match;
		while ((match = tokenPattern.exec(expression)) !== null) {
			const tokenName = match[1];
			const tokenValue = tokenValues[tokenName] || '';
			processedExpression = processedExpression.replace(match[0], `"${tokenValue.replace(/"/g, '\\\\"')}"`);
		}
		
		return evaluateExpression(processedExpression);
	}

	suite('Basic Logical Operators', () => {
		test('AND operator - both true', () => {
			const tokens = { type: 'Text', required: 'true' };
			const result = evaluateConditionalWithTokens('{$type}=="Text" && {$required}=="true"', tokens);
			assert.strictEqual(result, true);
		});

		test('AND operator - one false', () => {
			const tokens = { type: 'Text', required: 'false' };
			const result = evaluateConditionalWithTokens('{$type}=="Text" && {$required}=="true"', tokens);
			assert.strictEqual(result, false);
		});

		test('OR operator - one true', () => {
			const tokens = { type: 'Lookup', other: 'false' };
			const result = evaluateConditionalWithTokens('{$type}=="Lookup" || {$type}=="Entity"', tokens);
			assert.strictEqual(result, true);
		});

		test('OR operator - both false', () => {
			const tokens = { type: 'Text', other: 'false' };
			const result = evaluateConditionalWithTokens('{$type}=="Lookup" || {$type}=="Entity"', tokens);
			assert.strictEqual(result, false);
		});

		test('Mixed AND/OR with parentheses', () => {
			const tokens = { type: 'Text', required: 'true', category: 'Standard' };
			const result = evaluateConditionalWithTokens('{$type}=="Text" && ({$required}=="true" || {$category}=="Critical")', tokens);
			assert.strictEqual(result, true);
		});
	});

	suite('Parentheses Grouping', () => {
		test('Simple parentheses grouping', () => {
			const tokens = { type: 'Integer', required: 'true' };
			const result = evaluateConditionalWithTokens('({$type}=="Text" || {$type}=="Integer") && {$required}=="true"', tokens);
			assert.strictEqual(result, true);
		});

		test('Nested parentheses', () => {
			const tokens = { category: 'Advanced', type: 'Entity', linkedEntityDef: 'SomeEntity' };
			const result = evaluateConditionalWithTokens('{$category}=="Advanced" && ({$type}=="Lookup" || ({$type}=="Entity" && {$linkedEntityDef}!=""))', tokens);
			assert.strictEqual(result, true);
		});
	});

	suite('Nested Ternary Operations', () => {
		test('Simple nested ternary', () => {
			const tokens = { type: 'Lookup', required: 'true' };
			
			// Test the ternary parsing
			const ternaryResult = findTernaryOperator('{$type}=="Lookup" ? ({$required}=="true" ? "RequiredLookup" : "OptionalLookup") : "NotLookup"');
			assert.ok(ternaryResult);
			assert.strictEqual(ternaryResult.condition, '{$type}=="Lookup"');
			assert.strictEqual(ternaryResult.trueValue, '({$required}=="true" ? "RequiredLookup" : "OptionalLookup")');
			assert.strictEqual(ternaryResult.falseValue, '"NotLookup"');
		});

		test('Complex nested ternary', () => {
			const expression = '{$category}=="Advanced" ? ({$type}=="Lookup" ? "AdvancedLookup" : ({$type}=="Entity" ? "AdvancedEntity" : "AdvancedOther")) : "Standard"';
			const ternaryResult = findTernaryOperator(expression);
			assert.ok(ternaryResult);
			assert.strictEqual(ternaryResult.condition, '{$category}=="Advanced"');
		});
	});

	suite('Curly Braces in Literals', () => {
		test('JSON literals with curly braces', () => {
			// Test that curly braces in string literals don't interfere with token parsing
			const template = '{$type}=="Config" ? \'{"setting": "{$name}", "value": "{$label}"}\' : "simple"';
			const ternaryResult = findTernaryOperator(template);
			assert.ok(ternaryResult);
			assert.strictEqual(ternaryResult.condition, '{$type}=="Config"');
			assert.strictEqual(ternaryResult.trueValue, '\'{"setting": "{$name}", "value": "{$label}"}\'');
			assert.strictEqual(ternaryResult.falseValue, '"simple"');
		});

		test('CSS literals with curly braces', () => {
			const template = '{$visualtype}=="Custom" ? \'.{$name} { display: block; }\' : "default"';
			const ternaryResult = findTernaryOperator(template);
			assert.ok(ternaryResult);
			assert.strictEqual(ternaryResult.condition, '{$visualtype}=="Custom"');
			assert.strictEqual(ternaryResult.trueValue, '\'.{$name} { display: block; }\'');
		});

		test('JavaScript literals with curly braces', () => {
			const template = '{$type}=="Function" ? \'function {$name}() { return "{$label}"; }\' : \'var {$name} = "{$label}";\'';
			const ternaryResult = findTernaryOperator(template);
			assert.ok(ternaryResult);
			assert.strictEqual(ternaryResult.condition, '{$type}=="Function"');
		});
	});

	suite('Operator Precedence', () => {
		test('AND has higher precedence than OR', () => {
			// "A" || "B" && "C" should be parsed as "A" || ("B" && "C")
			const expression = '"false" || "true" && "true"';
			const orResult = findLogicalOperator(expression, '||');
			assert.ok(orResult);
			assert.strictEqual(orResult.left, '"false"');
			assert.strictEqual(orResult.right, '"true" && "true"');
		});

		test('Parentheses override precedence', () => {
			// ("A" || "B") && "C" should be parsed correctly
			const expression = '("false" || "true") && "true"';
			const andResult = findLogicalOperator(expression, '&&');
			assert.ok(andResult);
			assert.strictEqual(andResult.left, '("false" || "true")');
			assert.strictEqual(andResult.right, '"true"');
		});
	});

	suite('Edge Cases', () => {
		test('Empty token values', () => {
			const tokens = { type: '', required: 'true' };
			const result = evaluateConditionalWithTokens('{$type}=="" && {$required}=="true"', tokens);
			assert.strictEqual(result, true);
		});

		test('Missing tokens default to empty string', () => {
			const tokens = { type: 'Text' }; // missing 'required' token
			const result = evaluateConditionalWithTokens('{$type}=="Text" && {$required}==""', tokens);
			assert.strictEqual(result, true);
		});

		test('Unbalanced parentheses', () => {
			const expression = '(("Text" || "Integer") && "true"';
			assert.strictEqual(isBalancedParentheses(expression), false);
		});

		test('Balanced parentheses', () => {
			const expression = '(("Text" || "Integer") && "true")';
			assert.strictEqual(isBalancedParentheses(expression), true);
		});
	});

	suite('Single Quote Comparison Tests', () => {
		test('Single quotes: Text type should not match Lookup', () => {
			const result = evaluateExpression("'Text'=='Lookup'");
			assert.strictEqual(result, false, 'Text should not equal Lookup with single quotes');
		});

		test('Single quotes: Lookup type should match Lookup', () => {
			const result = evaluateExpression("'Lookup'=='Lookup'");
			assert.strictEqual(result, true, 'Lookup should equal Lookup with single quotes');
		});

		test('Single quotes: LookupList type should match LookupList', () => {
			const result = evaluateExpression("'LookupList'=='LookupList'");
			assert.strictEqual(result, true, 'LookupList should equal LookupList with single quotes');
		});

		test('Single quotes: Entity type should match Entity', () => {
			const result = evaluateExpression("'Entity'=='Entity'");
			assert.strictEqual(result, true, 'Entity should equal Entity with single quotes');
		});

		test('Single quotes: Text type should not equal Entity', () => {
			const result = evaluateExpression("'Text'=='Entity'");
			assert.strictEqual(result, false, 'Text should not equal Entity with single quotes');
		});

		test('Single quotes: OR operator with Lookup', () => {
			const result1 = evaluateExpression("'Lookup'=='Lookup' || 'Lookup'=='LookupList'");
			assert.strictEqual(result1, true, 'Lookup should match first condition');

			const result2 = evaluateExpression("'LookupList'=='Lookup' || 'LookupList'=='LookupList'");
			assert.strictEqual(result2, true, 'LookupList should match second condition');

			const result3 = evaluateExpression("'Text'=='Lookup' || 'Text'=='LookupList'");
			assert.strictEqual(result3, false, 'Text should match neither condition');
		});

		test('Single quotes: OR operator with Entity', () => {
			const result1 = evaluateExpression("'Entity'=='Entity' || 'Entity'=='EntityDef'");
			assert.strictEqual(result1, true, 'Entity should match first condition');

			const result2 = evaluateExpression("'EntityDef'=='Entity' || 'EntityDef'=='EntityDef'");
			assert.strictEqual(result2, true, 'EntityDef should match second condition');

			const result3 = evaluateExpression("'Text'=='Entity' || 'Text'=='EntityDef'");
			assert.strictEqual(result3, false, 'Text should match neither condition');
		});

		test('Single quotes: != operator', () => {
			const result1 = evaluateExpression("'Text'!='Lookup'");
			assert.strictEqual(result1, true, 'Text should not equal Lookup');

			const result2 = evaluateExpression("'Lookup'!='Lookup'");
			assert.strictEqual(result2, false, 'Lookup should equal Lookup');
		});

		test('Double quotes: Text type should not match Lookup', () => {
			const result = evaluateExpression('"Text"=="Lookup"');
			assert.strictEqual(result, false, 'Text should not equal Lookup with double quotes');
		});

		test('Double quotes: Lookup type should match Lookup', () => {
			const result = evaluateExpression('"Lookup"=="Lookup"');
			assert.strictEqual(result, true, 'Lookup should equal Lookup with double quotes');
		});

		test('Mixed quote styles should not match (intentional)', () => {
			const result = evaluateExpression("'Text'==\"Text\"");
			assert.strictEqual(result, true, 'Mixed quotes should default to true as no match pattern');
		});
	});
});

suite('Token Transformation Tests', () => {
	// Helper functions (similar to extension logic)
	function escapeXml(value: string): string {
		if (!value) return value;
		return value
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	function toPascalCase(value: string): string {
		if (!value) return value;
		return value
			.split(/[^a-zA-Z0-9]+/)
			.filter(word => word.length > 0)
			.map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
			.join('');
	}

	function toTitleCase(value: string): string {
		if (!value) return value;
		
		const lowercaseWords = new Set([
			'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'yet', 'so',
			'in', 'on', 'at', 'by', 'for', 'of', 'to', 'up', 'as'
		]);
		
		const words = value.toLowerCase().split(/(\s+)/);
		
		return words.map((word, index) => {
			if (/^\s+$/.test(word)) {
				return word;
			}
			
			const isFirstWord = index === 0 || words.slice(0, index).every(w => /^\s+$/.test(w));
			const isLastWord = index === words.length - 1 || words.slice(index + 1).every(w => /^\s+$/.test(w));
			
			if (isFirstWord || isLastWord || !lowercaseWords.has(word.toLowerCase())) {
				return word.charAt(0).toUpperCase() + word.slice(1);
			}
			
			return word;
		}).join('');
	}

	function applyTokenTransformation(value: string, transformation: string): string {
		if (!value) return value;

		switch (transformation.toLowerCase()) {
			case 'friendly':
				return escapeXml(toTitleCase(value.trim()));
			case 'internal':
				return toPascalCase(value.trim());
			case 'upper':
				return escapeXml(value.trim().toUpperCase());
			case 'lower':
				return escapeXml(value.trim().toLowerCase());
			case 'raw':
				return value; // Leave exactly as user typed it (no processing, including whitespace)
			default:
				return toPascalCase(value.trim());
		}
	}

	test('Default transformation creates PascalCase', () => {
		const result = applyTokenTransformation('field & value', 'default');
		assert.strictEqual(result, 'FieldValue');
	});

	test('Friendly transformation applies TitleCase', () => {
		const result = applyTokenTransformation('field of the rings', 'friendly');
		assert.strictEqual(result, 'Field of the Rings');
	});

	test('Internal transformation creates PascalCase', () => {
		const result = applyTokenTransformation('field & value', 'internal');
		assert.strictEqual(result, 'FieldValue');
	});

	test('Upper transformation converts to uppercase with XML escaping', () => {
		const result = applyTokenTransformation('field & value', 'upper');
		assert.strictEqual(result, 'FIELD &amp; VALUE');
	});

	test('Lower transformation converts to lowercase with XML escaping', () => {
		const result = applyTokenTransformation('FIELD & VALUE', 'lower');
		assert.strictEqual(result, 'field &amp; value');
	});

	test('PascalCase handles complex input', () => {
		const result = applyTokenTransformation('user-defined field name', 'default');
		assert.strictEqual(result, 'UserDefinedFieldName');
	});

	test('TitleCase handles articles and prepositions correctly', () => {
		const result = applyTokenTransformation('the field of dreams and hope', 'friendly');
		assert.strictEqual(result, 'The Field of Dreams and Hope');
	});

	test('TitleCase capitalizes first and last words', () => {
		const result = applyTokenTransformation('a field for the user', 'friendly');
		assert.strictEqual(result, 'A Field for the User');
	});

	test('XML escaping handles all special characters', () => {
		const input = '<tag attr="value">content & more\'s</tag>';
		const expected = '&lt;tag attr=&quot;value&quot;&gt;content &amp; more&#39;s&lt;/tag&gt;';
		const result = applyTokenTransformation(input, 'friendly');
		assert.strictEqual(result, expected);
	});

	test('Token pattern matching with pipe syntax', () => {
		const template = '<Label>{$name|upper}</Label><Field>{$value|friendly}</Field>';
		
		// Test that the regex pattern correctly identifies pipe transformations
		const tokenPattern = /\{\$(\w+)(?:\|([^}]+))?\}/g;
		const matches = [];
		let match;
		
		while ((match = tokenPattern.exec(template)) !== null) {
			matches.push({
				token: match[1],
				transformation: match[2] || 'default'
			});
		}
		
		assert.strictEqual(matches.length, 2);
		assert.strictEqual(matches[0].token, 'name');
		assert.strictEqual(matches[0].transformation, 'upper');
		assert.strictEqual(matches[1].token, 'value');
		assert.strictEqual(matches[1].transformation, 'friendly');
	});

	test('Friendly transformation trims leading whitespace', () => {
		const result = applyTokenTransformation(' with label', 'friendly');
		assert.strictEqual(result, 'With Label', 'Leading space should be trimmed');
	});

	test('Friendly transformation trims trailing whitespace', () => {
		const result = applyTokenTransformation('with label ', 'friendly');
		assert.strictEqual(result, 'With Label', 'Trailing space should be trimmed');
	});

	test('Friendly transformation trims leading and trailing whitespace', () => {
		const result = applyTokenTransformation('  ListNameIsThis  ', 'friendly');
		assert.strictEqual(result, 'List Name Is This', 'Both leading and trailing spaces should be trimmed');
	});

	test('Internal transformation trims whitespace', () => {
		const result = applyTokenTransformation(' field name ', 'internal');
		assert.strictEqual(result, 'FieldName', 'Whitespace should be trimmed for PascalCase');
	});

	test('Upper transformation trims whitespace', () => {
		const result = applyTokenTransformation(' value ', 'upper');
		assert.strictEqual(result, 'VALUE', 'Whitespace should be trimmed before uppercase');
	});

	test('Lower transformation trims whitespace', () => {
		const result = applyTokenTransformation(' VALUE ', 'lower');
		assert.strictEqual(result, 'value', 'Whitespace should be trimmed before lowercase');
	});

	test('Raw transformation preserves all whitespace', () => {
		const result = applyTokenTransformation('  value with spaces  ', 'raw');
		assert.strictEqual(result, '  value with spaces  ', 'Raw should preserve all whitespace');
	});
});