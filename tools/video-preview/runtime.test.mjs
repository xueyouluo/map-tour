import { expect, it } from 'vitest';
import { runFile } from './runtime.mjs';

it('cancels its own subprocess instead of leaving a blocked external asset request running', async () => {
  const cancellation = new AbortController();
  const task = runFile(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 10000)'],
    { signal: cancellation.signal }
  );
  const timer = setTimeout(() => cancellation.abort(), 30);
  try {
    await expect(task).rejects.toThrow();
  } finally {
    clearTimeout(timer);
  }
});
