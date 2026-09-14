import { describe, it, expect } from 'vitest';
import { countLines } from './loc';

describe('countLines', () => {
  it('counts code lines, skipping blanks and comments of both kinds', () => {
    const src = [
      '/**',
      ' * A doc comment.',
      ' */',
      '',
      'import x from "y"; // trailing comments stay code',
      '// a line comment',
      'const a = 1;',
      '/* one-line block */',
      'const b = 2; /* inline */',
      '',
    ].join('\n');
    expect(countLines(src)).toEqual({ total: 10, code: 3, comment: 5 });
  });

  it('handles windows line endings', () => {
    expect(countLines('a\r\n\r\nb\r\n').code).toBe(2);
  });
});
