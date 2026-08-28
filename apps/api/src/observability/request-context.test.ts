import { currentRequestId, requestContext } from './request-context';

describe('request context', () => {
  it('returns a placeholder outside of a request', () => {
    expect(currentRequestId()).toBe('no-request');
  });

  it('exposes the id to everything running inside the request scope', async () => {
    const seen = await new Promise<string>((resolve) => {
      requestContext.run({ requestId: 'req-42' }, () => {
        setTimeout(() => resolve(currentRequestId()), 0);
      });
    });

    expect(seen).toBe('req-42');
  });

  it('keeps concurrent requests isolated', async () => {
    const run = (id: string) =>
      new Promise<string>((resolve) => {
        requestContext.run({ requestId: id }, () => {
          setTimeout(() => resolve(currentRequestId()), 5);
        });
      });

    await expect(Promise.all([run('a'), run('b')])).resolves.toEqual(['a', 'b']);
  });
});
