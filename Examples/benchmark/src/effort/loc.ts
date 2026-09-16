/**
 * Lines of code, the way a reader would count them: blank lines and
 * comment lines are not code. Block comments are tracked across lines.
 */

export interface LineCount {
  total: number;
  code: number;
  comment: number;
}

export function countLines(source: string): LineCount {
  const lines = source.split(/\r?\n/);
  let inBlock = false;
  let code = 0;
  let comment = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    if (inBlock) {
      comment += 1;
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line.startsWith('//')) {
      comment += 1;
      continue;
    }
    if (line.startsWith('/*')) {
      comment += 1;
      if (!line.includes('*/')) inBlock = true;
      continue;
    }
    code += 1;
  }
  return { total: lines.length, code, comment };
}
