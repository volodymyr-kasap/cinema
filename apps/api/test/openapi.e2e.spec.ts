import { VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { generateRequestId, registerCorrelation } from '../src/observability/logger';

describe('GET /api/openapi.json', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ logger: false, genReqId: generateRequestId }),
    );
    registerCorrelation(app);
    app.setGlobalPrefix('api', { exclude: ['health', 'ready'] });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the generated document', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/openapi.json' });

    expect(response.statusCode).toBe(200);
    const document = response.json() as { openapi: string; paths: Record<string, unknown> };
    expect(document.openapi).toBe('3.0.3');
    expect(Object.keys(document.paths)).toHaveLength(7);
  });
});
