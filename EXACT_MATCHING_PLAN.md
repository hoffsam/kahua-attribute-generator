# Exact Matching Implementation Plan

## Goal
Replace fuzzy scoring with exact matching that respects `attributeMatchOrderForInjection` fallbacks.

## New Functions Needed

### 1. `targetExactlyMatchesAllTokens()`
- Takes: target, tokens Map, tokenDefinitions
- Returns: boolean
- Logic: Returns true only if ALL tokens match the target exactly

### 2. `tokenMatchesTarget()`
- Takes: target, tokenName, tokenValue, metadata
- Returns: boolean  
- Logic:
  1. Try each attribute in `attributeMatchOrderForInjection` order
  2. Stop at first match
  3. Also check if value appears as complete token in injection path
  4. Return true if ANY fallback matches

### 3. `trySmartInjectionResolution()` - REWRITE
- Current: Uses fuzzy scoring, picks highest score
- New: Filter targets to those matching ALL tokens exactly, return if exactly 1

## Algorithm

```typescript
function trySmartInjectionResolution(...): XmlTargetSection | undefined {
  // Find targets that exactly match ALL tokens
  const exactMatches = targets.filter(target => 
    targetExactlyMatchesAllTokens(target, affectingTokens, tokenDefinitions)
  );
  
  // Only auto-inject if exactly ONE match
  if (exactMatches.length === 1) {
    return exactMatches[0];
  }
  
  // 0 or multiple matches → prompt user
  return undefined;
}
```

## Configuration Respect

**appname** with `attributeMatchOrderForInjection: ['Name', 'Extends', 'any']`:
- First try: App/@Name === value
- Then try: App/@Extends === value  
- Then try: ANY App attribute === value
- Stop at FIRST match

**entity** with no fallbacks:
- Check if value appears as complete token in injection path
- Must use token boundaries (not substring)

## Expected Behavior

### Scenario 1: Clear winner
- Tokens: appname='kahua_AEC_RFI', entity='RFI'
- Target 1: EntityDefName='kahua_AEC_RFI.Other' → appname✓ entity✗ → NO MATCH
- Target 2: EntityDefName='kahua_AEC_RFI.RFI' → appname✓ entity✓ → EXACT MATCH
- Result: Auto-inject Target 2 ✓

### Scenario 2: Tie (multiple exact matches)
- Both targets match ALL tokens exactly
- Result: Prompt user (no auto-inject)

### Scenario 3: No exact matches
- No target matches ALL tokens
- Result: Prompt user (no auto-inject)
