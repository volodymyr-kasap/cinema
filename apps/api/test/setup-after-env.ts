import { readFileSync } from 'node:fs';

process.env.DATABASE_URL = readFileSync(`${__dirname}/.database-url`, 'utf8').trim();
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
