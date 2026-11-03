import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { diagnosticError, diagnosticText } from './diagnostics';

it('preserves iframe stacks and the underlying failure without serializing arbitrary error properties', () => {
  const cause = runInNewContext('new Error("地图素材加载超时")');
  const error = Object.assign(new Error('第 395 帧失败', { cause }), { itinerary: 'private itinerary' });
  const result = diagnosticError(error);
  expect(result.message).toBe('第 395 帧失败');
  expect(result.cause?.message).toBe('地图素材加载超时');
  expect(result.cause?.stack).toContain('Error: 地图素材加载超时');
  expect(JSON.stringify(result)).not.toContain('private itinerary');
});

it('redacts credentials and URL queries while retaining script paths and stack positions', () => {
  const result = diagnosticText('Failed https://name:pass@example.test/assets/app.js:12:4?key=url-secret&jscode=js-secret#fragment ' +
    'OPENAI_API_KEY=api-secret token=token-secret password=pass-secret Cookie: session=cookie-secret Authorization: Bearer bearer-secret', 4000);
  for (const secret of ['name:pass', 'url-secret', 'js-secret', 'api-secret', 'token-secret', 'pass-secret', 'cookie-secret', 'bearer-secret'])
    expect(result).not.toContain(secret);
  expect(result).toContain('https://example.test/assets/app.js:12:4');
});

it('bounds long messages and cause chains including cycles', () => {
  const error = Object.assign(new Error('x'.repeat(2000)), { cause: undefined as unknown });
  error.cause = error;
  expect(diagnosticError(error).cause).toBeUndefined();
  expect(diagnosticError(error).message).toHaveLength(1000);
  expect(diagnosticError(new Error('a', { cause: new Error('b', { cause: new Error('c', { cause: new Error('d') }) }) })).cause?.cause?.cause)
    .toBeUndefined();
});
