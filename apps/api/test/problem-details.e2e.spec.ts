import { problemDetailsSchema } from '@cinema/contracts';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { ConfigService } from '../src/config/config.service';
import { ProblemDetailsFilter } from '../src/http/problem-details.filter';
import { generateRequestId, registerCorrelation } from '../src/observability/logger';
import { BrokenModule } from './fixtures/broken.module';

describe('Problem Details', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres://cinema:cinema@localhost:5432/cinema';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, BrokenModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ logger: false, genReqId: generateRequestId }),
    );
    registerCorrelation(app);
    app.useGlobalFilters(new ProblemDetailsFilter(app.get(ConfigService)));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('renders a domain error as RFC 9457 with the request id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/__test/not-found',
      headers: { 'x-request-id': 'trace-me' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');

    const problem = problemDetailsSchema.parse(response.json());
    expect(problem.status).toBe(404);
    expect(problem.type).toMatch(/\/not-found$/);
    expect(problem.instance).toBe('/__test/not-found');
    expect(problem.traceId).toBe('trace-me');
  });

  it('never leaks internals of an unexpected failure', async () => {
    const response = await app.inject({ method: 'GET', url: '/__test/boom' });

    expect(response.statusCode).toBe(500);
    const problem = problemDetailsSchema.parse(response.json());
    expect(problem.detail).not.toContain('secret');
    expect(problem.title).toBe('Internal server error');
  });

  it('renders an unknown route as a problem document too', async () => {
    const response = await app.inject({ method: 'GET', url: '/__test/nope' });

    expect(response.statusCode).toBe(404);
    expect(problemDetailsSchema.safeParse(response.json()).success).toBe(true);
  });
});
