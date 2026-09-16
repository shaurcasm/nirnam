/**
 * Runner state for a tab: start, abort, progress, results. Results are also
 * put on `window.__bench[name]` so a script (or a person in the console)
 * can read a run without the clipboard.
 */

import { useCallback, useRef, useState } from 'react';
import { runCases, type Case, type CaseResult } from './runner';

export function useRunner(name: string, reps = 3) {
  const [results, setResults] = useState<CaseResult[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: Case | null } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(
    async (cases: Case[]) => {
      abortRef.current = new AbortController();
      setRunning(true);
      setResults([]);
      try {
        const out = await runCases(cases, { reps, onProgress: setProgress, signal: abortRef.current.signal });
        setResults(out);
        const w = window as unknown as { __bench?: Record<string, CaseResult[]> };
        (w.__bench ??= {})[name] = out;
      } finally {
        setRunning(false);
        setProgress(null);
      }
    },
    [name, reps],
  );

  const abort = useCallback(() => abortRef.current?.abort(), []);

  return { results, running, progress, start, abort };
}
