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

  interface Operation {
    requestBody?: unknown;
    responses: Record<string, unknown>;
  }

  const fetchDocument = async () => {
    const response = await app.inject({ method: 'GET', url: '/api/openapi.json' });
    expect(response.statusCode).toBe(200);
    return response.json() as {
      openapi: string;
      paths: Record<string, Partial<Record<'get' | 'post' | 'delete', Operation>>>;
    };
  };

  it('serves the generated document', async () => {
    const document = await fetchDocument();

    expect(document.openapi).toBe('3.0.3');
    // Seven catalogue paths plus the three the reservation endpoints occupy.
    expect(Object.keys(document.paths)).toHaveLength(10);
  });

  it('documents the reservation endpoints with their bodies', async () => {
    const document = await fetchDocument();

    expect(document.paths['/api/v1/reservations']?.post).toBeDefined();
    expect(document.paths['/api/v1/reservations/{id}']?.delete).toBeDefined();
    expect(document.paths['/api/v1/reservations/{id}/confirm']?.post).toBeDefined();

    const create = document.paths['/api/v1/reservations']?.post;
    expect(create?.requestBody).toBeDefined();
    expect(create?.responses['409']).toBeDefined();
  });

  // A GET and a POST share this path; the builder must merge them rather than
  // let the second overwrite the first.
  it('keeps both operations on a path served by two methods', async () => {
    const document = await fetchDocument();

    expect(document.paths['/api/v1/reservations']?.get).toBeDefined();
    expect(document.paths['/api/v1/reservations']?.post).toBeDefined();
  });
});
