import { readFileSync } from 'node:fs';

process.env.DATABASE_URL = readFileSync(`${__dirname}/.database-url`, 'utf8').trim();
process.env.REDIS_URL = readFileSync(`${__dirname}/.redis-url`, 'utf8').trim();
process.env.RABBITMQ_URL = readFileSync(`${__dirname}/.rabbit-url`, 'utf8').trim();
process.env.RABBITMQ_MANAGEMENT_URL = readFileSync(
  `${__dirname}/.rabbit-management-url`,
  'utf8',
).trim();
process.env.PAYMENT_PROVIDER_URL = readFileSync(`${__dirname}/.provider-url`, 'utf8').trim();
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
