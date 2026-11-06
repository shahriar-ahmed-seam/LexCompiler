import { describe, expect, it } from 'vitest';
import { changedHunks, diffLinesByFile } from './github/fixes.js';
import { keepRetrievedCitations } from './github/explanations.js';

describe('suggested changes: diff arithmetic', () => {
  it('reads the new-side lines of each hunk in a pull request patch', () => {
    const patch = ['@@ -1,3 +1,4 @@', ' a', '-b', '+B', '+B2', ' c', '@@ -10,2 +11,2 @@', ' x', '-y', '+Y', '\\ No newline at end of file'].join('\n');
    expect([...diffLinesByFile([{ filename: 'f.py', patch }]).get('f.py')!]).toEqual([1, 2, 3, 4, 11, 12]);
    // A file without a patch (binary or too large) has no commentable lines.
    expect(diffLinesByFile([{ filename: 'big.sql' }]).get('big.sql')!.size).toBe(0);
  });

  it('finds replacements, insertions and deletions between two versions', () => {
    expect(changedHunks('a\nb\nc\n', 'a\nB\nc\n')).toEqual([{ start: 2, end: 2, replacement: ['B'] }]);
    expect(changedHunks('a\nc\n', 'a\nb\nc\n')).toEqual([{ start: 2, end: 1, replacement: ['b'] }]);
    expect(changedHunks('a\nb\nc\nd\n', 'a\nc\nD\n')).toEqual([
      { start: 2, end: 2, replacement: [] },
      { start: 4, end: 4, replacement: ['D'] },
    ]);
  });
});

describe('AI explanations: citations', () => {
  it('keeps only retrieved chunk ids, in the list and in the text', () => {
    const ids = new Set(['rule:R-2', 'code:api/x.py:15-27']);
    expect(keepRetrievedCitations('Logs must be redacted [rule:R-2]. Line 21 is not [code:api/x.py:15-27] [made:up].', ['rule:R-2', 'made:up'], ids)).toEqual({
      text: 'Logs must be redacted [rule:R-2]. Line 21 is not [code:api/x.py:15-27].',
      citations: ['rule:R-2'],
    });
    expect(keepRetrievedCitations('Nothing retrieved [other].', ['other'], ids).citations).toEqual([]);
  });
});
