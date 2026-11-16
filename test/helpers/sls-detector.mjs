import assert from 'node:assert/strict';

export const SYNTHETIC_CANARIES = ['张三', '13800138000', 'alice@example.com'];

export function slsDetector({ status = 'complete', credentials, inspect = () => {} } = {}) {
  return async (_url, init) => {
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), null, 'SLS credentials must not reach the detector');
    assert.equal(headers.get('x-acs-security-token'), null);
    for (const value of [credentials?.accessKeyId, credentials?.accessKeySecret, credentials?.securityToken]) {
      if (value) assert.ok(!init.body.includes(value));
    }
    inspect(init);
    const { texts } = JSON.parse(init.body);
    return Response.json({
      request_id: headers.get('x-request-id'), model_version: 'synthetic-test-only',
      results: texts.map(({ id, revision, text }) => {
        const entities = [];
        for (const [index, canary] of SYNTHETIC_CANARIES.entries()) {
          let cursor = 0;
          for (;;) {
            const found = text.indexOf(canary, cursor);
            if (found < 0) break;
            const start = Array.from(text.slice(0, found)).length;
            entities.push({ start, end: start + Array.from(canary).length, type: ['NAME', 'PHONE', 'EMAIL'][index] });
            cursor = found + canary.length;
          }
        }
        return { id, revision, status, entities: status === 'complete' ? entities : [] };
      }),
    });
  };
}
