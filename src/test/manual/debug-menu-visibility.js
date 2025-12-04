// Debug script to analyze menu visibility conditions
const fs = require('fs');

console.log('=== MENU VISIBILITY DEBUG ===\n');

// Read package.json to analyze menu conditions
const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));

console.log('1. COMMAND PALETTE CONDITIONS:');
const commands = packageJson.contributes.commands || [];
commands.forEach(cmd => {
  if (cmd.command && cmd.command.startsWith('kahua.')) {
    console.log(`   ${cmd.command}: ${cmd.when || 'NO CONDITION'}`);
  }
});

console.log('\n2. CONTEXT MENU CONDITIONS:');
const menus = packageJson.contributes.menus || {};
Object.keys(menus).forEach(menuType => {
  if (menuType.includes('editor') || menuType.includes('context')) {
    console.log(`\n   ${menuType}:`);
    menus[menuType].forEach(item => {
      if (item.command && item.command.startsWith('kahua.')) {
        console.log(`     ${item.command}: ${item.when || 'NO CONDITION'}`);
      }
    });
  }
});

console.log('\n3. CONTEXT VARIABLE DEFINITIONS:');
const contextVars = [
  'kahua.isKahuaDocument',
  'kahua.hasApplicableDocument', 
  'kahua.canGenerateFromSource',
  'kahua.canGenerateFromTemplate',
  'kahua.canGenerateFromSnippet',
  'kahua.canGenerateFromTable'
];

contextVars.forEach(varName => {
  console.log(`   ${varName}: Should be set by extension context detection`);
});

console.log('\n4. ANALYSIS:');
console.log('   - Command palette uses "when" clauses that depend on context variables');
console.log('   - Context menus use the SAME "when" clauses');
console.log('   - If command palette works but context menus don\'t, the issue is likely:');
console.log('     a) Context variable timing (set too late for menus)');
console.log('     b) Menu registration vs context detection race condition');
console.log('     c) VS Code menu refresh not triggered when context changes');

console.log('\n5. NEXT STEPS:');
console.log('   - Check extension activation timing');
console.log('   - Verify context variables are being set correctly');
console.log('   - Add debug logging to context detection functions');
console.log('   - Test manual context variable setting');

