import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { generateRequestId, registerCorrelation } from '../src/observability/logger';

describe('request correlation', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ logger: false, genReqId: generateRequestId }),
    );
    registerCorrelation(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('echoes an upstream x-request-id back to the caller', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'upstream-123' },
    });

    expect(response.headers['x-request-id']).toBe('upstream-123');
  });

  it('generates an id when the caller does not supply one', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(String(response.headers['x-request-id']).length).toBeGreaterThan(0);
  });
});
