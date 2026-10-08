import { describe, expect, it } from 'vitest';
import { asExpression, normalizeCondition } from './conditions';

describe('normalizeCondition', () => {
  it('keeps proper conditions as they are', () => {
    const rules = [{ left: '{{amount}}', op: 'greater_than', right: '100' }];
    expect(normalizeCondition({ match: 'any', rules })).toEqual({ match: 'any', rules });
    expect(normalizeCondition({ match: 'all', rules: [], expression: '' })).toEqual({ match: 'all', rules: [], expression: '' });
    expect(normalizeCondition(undefined)).toEqual({ match: 'all', rules: [] });
  });

  it('turns text into a formula', () => {
    expect(normalizeCondition("{{row['Paid']}}")).toEqual({ match: 'all', rules: [], expression: "{{row['Paid']}}" });
    expect(normalizeCondition('{{row["Amount"]}} > 100').expression).toBe('{{row["Amount"] > 100}}');
    expect(normalizeCondition('amount > 5').expression).toBe('{{amount > 5}}');
  });

  it('repairs text that was split into one entry per character', () => {
    const text = "{{row['inputFileExists']}}";
    const split = Object.fromEntries([...text].map((ch, i) => [String(i), ch]));
    // The rules a person added win; the stray characters are dropped.
    const rules = [{ left: '{{inputFileExists}}', op: 'equals', right: 'Yes' }];
    expect(normalizeCondition({ ...split, rules })).toEqual({ match: 'all', rules });
    // Without rules, the split text is the condition.
    expect(normalizeCondition(split)).toEqual({ match: 'all', rules: [], expression: text });
  });

  it('writes one formula for mixed text', () => {
    expect(asExpression('{{a}} and {{b}}')).toBe('{{a and b}}');
    expect(asExpression('  {{x}}  ')).toBe('{{x}}');
  });
});
