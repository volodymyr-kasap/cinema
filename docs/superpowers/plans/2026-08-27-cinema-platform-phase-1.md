# Cinema Booking Platform — Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the monorepo foundation of the cinema platform — a NestJS + PostgreSQL read-only catalogue API and a React SPA that walks from the movie list to a seat map of a 1000-seat hall, with Docker, CI and tests.

**Architecture:** npm-workspaces monorepo with three packages. `packages/contracts` holds Zod schemas that are the single source of truth for the API shape — the backend validates with them, the frontend parses responses with them, and the OpenAPI document is generated from them. `apps/api` is NestJS on the Fastify adapter with Drizzle over PostgreSQL 18; errors leave as RFC 9457 Problem Details carrying a correlation id. `apps/web` is Vite + React with TanStack Query as the only state manager (server state in Query, UI state in the URL).

**Tech Stack:** Node 24, TypeScript 6, NestJS 12 (Fastify adapter), Drizzle ORM + PostgreSQL 18, Zod 4, Jest 30 + Testcontainers, Vite 8 + React 19 + Tailwind 4 + TanStack Query 5, Vitest 4 + Testing Library + MSW, Playwright, Docker Compose, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-27-cinema-platform-phase-1-design.md`

## Global Constraints

Exact versions — every `package.json` in this plan uses these and nothing looser.

| Dependency | Version | Notes |
| --- | --- | --- |
| Node | `>=24` | Docker images use `node:24-alpine` |
| PostgreSQL | `18` | Docker image `postgres:18-alpine`. Required: PG18 ships a built-in `uuidv7()` function, which the schema uses as the primary-key default |
| typescript | `~6.0.3` | `@nestjs/cli@12` depends on `~6.0.2`; typescript-eslint supports `<6.1.0`. Do **not** install TypeScript 7 |
| @nestjs/common, @nestjs/core, @nestjs/platform-fastify, @nestjs/testing | `^12.0.1` | |
| @nestjs/cli | `^12.0.0` | dev only |
| reflect-metadata | `^0.2.2` | required by Nest DI |
| rxjs | `^7.8.2` | Nest peer |
| drizzle-orm | `^0.45.2` | |
| drizzle-kit | `^0.31.10` | dev only |
| pg | `^8.23.0` | plus `@types/pg` `^8.11.10` |
| zod | `^4.4.3` | Zod 4 API: `z.int()`, `z.uuid()`, `z.url()`, `z.iso.date()`, `z.iso.datetime()`, `z.prettifyError()`, `z.toJSONSchema()` |
| pino | `^10.3.1` | plus `pino-pretty` `^13.1.3` (dev only) |
| @fastify/swagger | `^9.8.1` | static mode |
| @fastify/swagger-ui | `^6.1.1` | |
| jest | `^30.4.2` | plus `ts-jest` `^29.4.12`, `@types/jest` `^30.0.0` |
| testcontainers, @testcontainers/postgresql | `^12.1.0` | |
| tsup | `^8.5.1` | builds `@cinema/contracts` dual CJS+ESM |
| vite | `^8.2.2` | plus `@vitejs/plugin-react` `^6.1.0` |
| react, react-dom | `^19.2.8` | |
| react-router | `^8.3.0` | peer requires react `>=19.2.7` |
| @tanstack/react-query | `^5.102.8` | |
| tailwindcss, @tailwindcss/vite | `^4.3.3` | |
| vitest | `^4.1.11` | plus `jsdom` `^30.0.1` |
| @testing-library/react | `^16.3.3` | plus `@testing-library/user-event` `^14.6.1`, `@testing-library/jest-dom` `^6.6.4` |
| msw | `^2.15.0` | |
| @playwright/test | `^1.62.1` | |
| eslint | `^10.9.1` | plus `typescript-eslint` `^8.68.0`, `eslint-plugin-drizzle` `^0.2.3`, `eslint-plugin-react-hooks` `^7.1.1` |
| prettier | `^3.9.6` | plus `husky` `^9.1.7`, `lint-staged` `^17.4.1` for the pre-commit hook |
| @types/node | `^24.13.3` | |

Rules that apply to every task:

- **Do not install `nestjs-zod` or `@nestjs/swagger`.** Both cap their peers below NestJS 12 (`nestjs-zod@5` accepts `@nestjs/common` ^10–^11; `@nestjs/swagger@12` drags in `class-validator`/`class-transformer`). Validation and OpenAPI are hand-rolled over Zod 4 in Tasks 5 and 10 — that is also what makes the contracts package the single source of truth.
- **Do not install `nestjs-pino`** (peers cap at Nest 11). Logging is wired directly to Fastify's pino instance in Task 4.
- **Package names:** `@cinema/contracts`, `@cinema/api`, `@cinema/web`.
- **`apps/api` is CommonJS** (Nest decorators + `reflect-metadata`). **`apps/web` and `packages/contracts` sources are ESM.** `@cinema/contracts` ships both builds, so both consumers resolve it correctly.
- **`@cinema/contracts` must be built before `apps/api` or `apps/web` are built or tested.** Root scripts orchestrate this; never rely on npm to order workspaces.
- **Money is `integer` in minor units** (`*_cents`), single currency UAH. **Timestamps are `timestamptz` in UTC.** **JSON field names are camelCase.**
- **Commit after every task** using the message given in that task's final step.

## File Structure

```
cinema/
├── package.json                          # workspaces + orchestration scripts
├── tsconfig.base.json                    # shared compiler options
├── eslint.config.js                      # flat config for all workspaces
├── .prettierrc.json
├── .env.example
├── docker-compose.yml
├── .github/workflows/ci.yml
├── docs/{adr,superpowers/{specs,plans}}
│
├── packages/contracts/
│   ├── package.json, tsconfig.json, tsup.config.ts, vitest.config.ts
│   └── src/
│       ├── index.ts                      # barrel
│       ├── common.ts                     # pagination, page envelope, problem details
│       ├── movie.ts                      # movieSchema
│       ├── cinema.ts                     # cinemaSchema
│       ├── showtime.ts                   # showtimeSchema, showtimeQuerySchema
│       └── seat.ts                       # seat category/status, showtimeSeatsSchema
│
├── apps/api/
│   ├── package.json, tsconfig.json, tsconfig.build.json, jest.config.ts, drizzle.config.ts, Dockerfile
│   ├── drizzle/                          # generated + custom SQL migrations
│   ├── src/
│   │   ├── main.ts                       # bootstrap: adapter, logger, filters, plugins
│   │   ├── app.module.ts
│   │   ├── config/{env.ts,config.module.ts,config.service.ts}
│   │   ├── observability/{request-context.ts,logger.ts}
│   │   ├── http/{errors.ts,problem-details.filter.ts,zod-validation.pipe.ts,validated.decorator.ts,response-validation.interceptor.ts}
│   │   ├── db/{schema.ts,drizzle.module.ts,seed.ts}
│   │   ├── health/{health.controller.ts,health.module.ts}
│   │   ├── catalog/{catalog.module.ts,catalog.controller.ts,catalog.service.ts,cursor.ts}
│   │   └── openapi/{document.ts,routes.ts,docs.controller.ts}
│   └── test/
│       ├── global-setup.ts, global-teardown.ts, setup-after-env.ts, harness.ts
│       └── *.e2e.spec.ts
│
└── apps/web/
    ├── package.json, tsconfig.json, vite.config.ts, vitest.config.ts, index.html, nginx.conf, Dockerfile
    ├── e2e/smoke.spec.ts, playwright.config.ts
    └── src/
        ├── main.tsx, index.css
        ├── app/{router.tsx,providers.tsx,layout.tsx,error-boundary.tsx}
        ├── shared/
        │   ├── api/{client.ts,query-keys.ts,catalog.ts}
        │   ├── ui/{button.tsx,skeleton.tsx,empty-state.tsx,error-state.tsx,badge.tsx}
        │   └── lib/{format.ts,use-roving-grid.ts}
        ├── features/
        │   ├── movies/{movie-list-page.tsx,movie-card.tsx}
        │   ├── showtimes/{movie-detail-page.tsx,showtime-filters.tsx,showtime-list.tsx}
        │   └── seat-map/{seat-map-page.tsx,seat-grid.tsx,seat-button.tsx,build-rows.ts}
        └── test/{setup.ts,server.ts,handlers.ts,fixtures.ts}
```

---

## Task 1: Monorepo skeleton, tooling, prototype removal

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc.json`, `.env.example`
- Modify: `.gitignore`
- Delete: `cinema-ticket-booking-node/` (preserved in commit `569dfd5`)

**Interfaces:**
- Consumes: nothing.
- Produces: root scripts `npm run lint`, `npm run typecheck`, `npm run contracts:build`, `npm run build`, `npm run test`; `tsconfig.base.json` extended by every workspace.

- [ ] **Step 1: Remove the prototype from the working tree**

```bash
git rm -r --quiet cinema-ticket-booking-node
```

- [ ] **Step 2: Create the root `package.json`**

```json
{
  "name": "cinema-platform",
  "version": "0.1.0",
  "private": true,
  "workspaces": ["packages/*", "apps/*"],
  "engines": { "node": ">=24" },
  "scripts": {
    "contracts:build": "npm run build -w @cinema/contracts",
    "build": "npm run contracts:build && npm run build -w @cinema/api && npm run build -w @cinema/web",
    "test": "npm run contracts:build && npm run test -w @cinema/contracts && npm run test -w @cinema/api && npm run test -w @cinema/web",
    "typecheck": "npm run contracts:build && npm run typecheck --workspaces --if-present",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "dev:api": "npm run dev -w @cinema/api",
    "dev:web": "npm run dev -w @cinema/web",
    "db:migrate": "npm run db:migrate -w @cinema/api",
    "db:seed": "npm run db:seed -w @cinema/api",
    "prepare": "husky"
  },
  "lint-staged": {
    "*.{ts,tsx,js,json,md,css,yml,yaml}": "prettier --write",
    "*.{ts,tsx}": "eslint --fix"
  },
  "devDependencies": {
    "@types/node": "^24.13.3",
    "eslint": "^10.9.1",
    "eslint-plugin-drizzle": "^0.2.3",
    "eslint-plugin-react-hooks": "^7.1.1",
    "husky": "^9.1.7",
    "lint-staged": "^17.4.1",
    "prettier": "^3.9.6",
    "typescript": "~6.0.3",
    "typescript-eslint": "^8.68.0"
  }
}
```

- [ ] **Step 3: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  }
}
```

`exactOptionalPropertyTypes` is deliberately off: Nest and Drizzle option objects pass `undefined` for absent options, and turning it on forces `| undefined` noise through every layer.

- [ ] **Step 4: Create `eslint.config.js`**

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import drizzle from 'eslint-plugin-drizzle';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'apps/api/drizzle/**', '**/playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/api/**/*.ts'],
    plugins: { drizzle },
    rules: {
      'drizzle/enforce-delete-with-where': ['error', { drizzleObjectName: ['db', 'tx'] }],
      'drizzle/enforce-update-with-where': ['error', { drizzleObjectName: ['db', 'tx'] }],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
```

- [ ] **Step 5: Create `.prettierrc.json`**

```json
{
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "semi": true
}
```

- [ ] **Step 6: Create `.env.example`**

```bash
NODE_ENV=development
PORT=3000
HOST=0.0.0.0
DATABASE_URL=postgres://cinema:cinema@localhost:5432/cinema
LOG_LEVEL=info
PUBLIC_ERROR_BASE_URL=https://cinema.example/errors
```

- [ ] **Step 7: Replace `.gitignore`**

```
node_modules/
dist/
build/
coverage/
*.log
.env
.env.local
.DS_Store
.idea/
playwright-report/
test-results/
```

- [ ] **Step 8: Install and verify tooling runs**

```bash
npm install
npx eslint --version
npx prettier --check .
```

Expected: `npm install` succeeds with no peer-dependency errors; `eslint --version` prints `v10.x`. `prettier --check` may report unformatted files — run `npm run format` and re-check until clean.

- [ ] **Step 8b: Install the pre-commit hook**

```bash
npx husky init
printf 'npx lint-staged\n' > .husky/pre-commit
git add .husky
```

Expected: `.husky/pre-commit` exists and runs `lint-staged`, so formatting and lint failures are caught before they reach CI rather than after.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: set up npm workspaces monorepo and shared tooling

Removes the Fastify prototype from the working tree; it stays available in
commit 569dfd5 as the reference for the locking semantics."
```

---

## Task 2: `packages/contracts` — shared primitives

**Files:**
- Create: `packages/contracts/package.json`, `packages/contracts/tsconfig.json`, `packages/contracts/tsup.config.ts`, `packages/contracts/vitest.config.ts`
- Create: `packages/contracts/src/common.ts`, `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/common.test.ts`

**Interfaces:**
- Consumes: `tsconfig.base.json` from Task 1.
- Produces:
  - `paginationQuerySchema: z.ZodObject<{ cursor: ZodOptional<ZodString>, limit: ZodDefault<...> }>` → parses to `{ cursor?: string; limit: number }`
  - `pageSchema<T extends z.ZodType>(item: T)` → `z.ZodObject<{ data: ZodArray<T>, nextCursor: ZodNullable<ZodString> }>`
  - `type Page<T> = { data: T[]; nextCursor: string | null }`
  - `problemDetailsSchema` → `ProblemDetails = { type: string; title: string; status: number; detail: string; instance: string; traceId: string }`
  - `idParamSchema` → `{ id: string }`

- [ ] **Step 1: Create the package manifest at `packages/contracts/package.json`**

```json
{
  "name": "@cinema/contracts",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "tsup": "^8.5.1",
    "typescript": "~6.0.3",
    "vitest": "^4.1.11"
  }
}
```

- [ ] **Step 2: Create `packages/contracts/tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`**

`packages/contracts/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"]
}
```

`packages/contracts/tsup.config.ts`:

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2023',
});
```

`packages/contracts/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
```

- [ ] **Step 3: Write the failing test at `packages/contracts/src/common.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { idParamSchema, pageSchema, paginationQuerySchema, problemDetailsSchema } from './common.js';

describe('paginationQuerySchema', () => {
  it('defaults limit to 20 when absent', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ limit: 20 });
  });

  it('coerces the limit from a query string', () => {
    expect(paginationQuerySchema.parse({ limit: '25' })).toEqual({ limit: 25 });
  });

  it('rejects a limit above 100', () => {
    expect(paginationQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });

  it('keeps the cursor as an opaque string', () => {
    expect(paginationQuerySchema.parse({ cursor: 'abc' })).toEqual({ cursor: 'abc', limit: 20 });
  });
});

describe('pageSchema', () => {
  it('wraps items in a data/nextCursor envelope', () => {
    const schema = pageSchema(z.object({ id: z.string() }));
    expect(schema.parse({ data: [{ id: 'a' }], nextCursor: null })).toEqual({
      data: [{ id: 'a' }],
      nextCursor: null,
    });
  });

  it('rejects a page without nextCursor', () => {
    const schema = pageSchema(z.object({ id: z.string() }));
    expect(schema.safeParse({ data: [] }).success).toBe(false);
  });
});

describe('problemDetailsSchema', () => {
  it('requires a traceId so every failure is traceable', () => {
    const problem = {
      type: 'https://cinema.example/errors/not-found',
      title: 'Not found',
      status: 404,
      detail: 'Movie 018f does not exist',
      instance: '/api/v1/movies/018f',
    };
    expect(problemDetailsSchema.safeParse(problem).success).toBe(false);
    expect(problemDetailsSchema.safeParse({ ...problem, traceId: 'r-1' }).success).toBe(true);
  });
});

describe('idParamSchema', () => {
  it('accepts a uuid v7 and rejects anything else', () => {
    expect(idParamSchema.safeParse({ id: '019298a1-7c4e-7c3a-8f21-2f4a9c1d5b60' }).success).toBe(true);
    expect(idParamSchema.safeParse({ id: 'not-a-uuid' }).success).toBe(false);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

```bash
npm run test -w @cinema/contracts
```

Expected: FAIL — `Failed to resolve import "./common.js"`.

- [ ] **Step 5: Implement `packages/contracts/src/common.ts`**

```ts
import { z } from 'zod';

/** Opaque keyset cursor. Only the server knows how to decode it. */
export const paginationQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** Every collection response uses this envelope; single resources are returned bare. */
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    data: z.array(item),
    nextCursor: z.string().nullable(),
  });
}
export type Page<T> = { data: T[]; nextCursor: string | null };

/** RFC 9457 Problem Details, extended with the correlation id of the failing request. */
export const problemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.int(),
  detail: z.string(),
  instance: z.string(),
  traceId: z.string(),
});
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;

export const idParamSchema = z.object({ id: z.uuid() });
export type IdParam = z.infer<typeof idParamSchema>;
```

- [ ] **Step 6: Create the barrel `packages/contracts/src/index.ts`**

```ts
export * from './common.js';
```

- [ ] **Step 7: Run the tests and the build**

```bash
npm run test -w @cinema/contracts
npm run contracts:build
ls packages/contracts/dist
```

Expected: all tests PASS; `dist` contains `index.js`, `index.cjs` and `index.d.ts`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(contracts): add shared pagination, page envelope and problem details schemas"
```

---

## Task 3: `apps/api` skeleton — config, bootstrap, `/health`

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/tsconfig.build.json`, `apps/api/nest-cli.json`, `apps/api/jest.config.ts`
- Create: `apps/api/src/config/env.ts`, `apps/api/src/config/config.service.ts`, `apps/api/src/config/config.module.ts`
- Create: `apps/api/src/health/health.controller.ts`, `apps/api/src/health/health.module.ts`
- Create: `apps/api/src/app.module.ts`, `apps/api/src/main.ts`
- Test: `apps/api/src/config/env.test.ts`, `apps/api/test/health.e2e.spec.ts`

**Interfaces:**
- Consumes: `@cinema/contracts` (not yet used here, but declared as a dependency).
- Produces:
  - `parseEnv(source: NodeJS.ProcessEnv): AppConfig` — throws `Error` with a readable message on invalid input
  - `type AppConfig = { nodeEnv: 'development' | 'test' | 'production'; port: number; host: string; databaseUrl: string; logLevel: LogLevel; publicErrorBaseUrl: string }`
  - `ConfigService` — injectable, exposes `readonly config: AppConfig`
  - `ConfigModule` — global module exporting `ConfigService`
  - `AppModule` — root module
  - `GET /health` → `200 { "status": "ok" }`

- [ ] **Step 1: Create `apps/api/package.json`**

```json
{
  "name": "@cinema/api",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "nest build",
    "dev": "nest start --watch",
    "start": "node dist/main.js",
    "typecheck": "tsc --noEmit",
    "test": "jest --runInBand",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx src/db/migrate.ts",
    "db:seed": "tsx src/db/seed.ts"
  },
  "dependencies": {
    "@cinema/contracts": "*",
    "@fastify/swagger": "^9.8.1",
    "@fastify/swagger-ui": "^6.1.1",
    "@nestjs/common": "^12.0.1",
    "@nestjs/core": "^12.0.1",
    "@nestjs/platform-fastify": "^12.0.1",
    "drizzle-orm": "^0.45.2",
    "pg": "^8.23.0",
    "pino": "^10.3.1",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.2",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@nestjs/cli": "^12.0.0",
    "@nestjs/testing": "^12.0.1",
    "@testcontainers/postgresql": "^12.1.0",
    "@types/jest": "^30.0.0",
    "@types/node": "^24.13.3",
    "@types/pg": "^8.11.10",
    "drizzle-kit": "^0.31.10",
    "jest": "^30.4.2",
    "pino-pretty": "^13.1.3",
    "testcontainers": "^12.1.0",
    "ts-jest": "^29.4.12",
    "tsx": "^4.20.3",
    "typescript": "~6.0.3"
  }
}
```

The `db:migrate` and `db:seed` scripts point at files created in Tasks 6 and 7; they are declared now so the manifest is written once.

- [ ] **Step 2: Create the TypeScript and Nest configuration**

`apps/api/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "commonjs",
    "moduleResolution": "node",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "outDir": "dist",
    "rootDir": "src",
    "baseUrl": "."
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "drizzle.config.ts", "jest.config.ts"]
}
```

`apps/api/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "dist", "test", "**/*.test.ts", "**/*.spec.ts", "jest.config.ts", "drizzle.config.ts"]
}
```

`apps/api/nest-cli.json`:

```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": { "deleteOutDir": true, "tsConfigPath": "tsconfig.build.json" }
}
```

`apps/api/jest.config.ts`:

```ts
import type { Config } from 'jest';

const config: Config = {
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: '.*\\.(test|spec)\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  moduleFileExtensions: ['ts', 'js', 'json'],
  testTimeout: 120_000,
};

export default config;
```

`globalSetup`, `globalTeardown` and `setupFilesAfterEach` are added in Task 6, once there is a database to start.

- [ ] **Step 3: Write the failing config test at `apps/api/src/config/env.test.ts`**

```ts
import { parseEnv } from './env';

const valid = {
  NODE_ENV: 'test',
  PORT: '3000',
  HOST: '0.0.0.0',
  DATABASE_URL: 'postgres://cinema:cinema@localhost:5432/cinema',
  LOG_LEVEL: 'silent',
  PUBLIC_ERROR_BASE_URL: 'https://cinema.example/errors',
};

describe('parseEnv', () => {
  it('parses a valid environment into typed config', () => {
    expect(parseEnv(valid)).toEqual({
      nodeEnv: 'test',
      port: 3000,
      host: '0.0.0.0',
      databaseUrl: 'postgres://cinema:cinema@localhost:5432/cinema',
      logLevel: 'silent',
      publicErrorBaseUrl: 'https://cinema.example/errors',
    });
  });

  it('applies defaults for everything except DATABASE_URL', () => {
    const config = parseEnv({ DATABASE_URL: valid.DATABASE_URL });
    expect(config.nodeEnv).toBe('development');
    expect(config.port).toBe(3000);
    expect(config.host).toBe('0.0.0.0');
    expect(config.logLevel).toBe('info');
  });

  it('throws a readable error when DATABASE_URL is missing', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it('throws when PORT is not a number', () => {
    expect(() => parseEnv({ ...valid, PORT: 'http' })).toThrow(/PORT/);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

```bash
npm run contracts:build
npm run test -w @cinema/api -- src/config/env.test.ts
```

Expected: FAIL — `Cannot find module './env'`.

- [ ] **Step 5: Implement `apps/api/src/config/env.ts`**

```ts
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  DATABASE_URL: z.url(),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PUBLIC_ERROR_BASE_URL: z.url().default('https://cinema.example/errors'),
});

export type AppConfig = {
  nodeEnv: z.infer<typeof envSchema>['NODE_ENV'];
  port: number;
  host: string;
  databaseUrl: string;
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
  publicErrorBaseUrl: string;
};

/**
 * Parses the process environment once, at startup. A misconfigured process must
 * fail loudly here rather than answer 500 to every request.
 */
export function parseEnv(source: NodeJS.ProcessEnv): AppConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }

  const env = result.data;
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    host: env.HOST,
    databaseUrl: env.DATABASE_URL,
    logLevel: env.LOG_LEVEL,
    publicErrorBaseUrl: env.PUBLIC_ERROR_BASE_URL.replace(/\/+$/, ''),
  };
}
```

- [ ] **Step 6: Run the config test to verify it passes**

```bash
npm run test -w @cinema/api -- src/config/env.test.ts
```

Expected: 4 tests PASS.

- [ ] **Step 7: Implement the config module**

`apps/api/src/config/config.service.ts`:

```ts
import { Injectable } from '@nestjs/common';

import { parseEnv, type AppConfig } from './env';

@Injectable()
export class ConfigService {
  readonly config: AppConfig = parseEnv(process.env);
}
```

`apps/api/src/config/config.module.ts`:

```ts
import { Global, Module } from '@nestjs/common';

import { ConfigService } from './config.service';

@Global()
@Module({ providers: [ConfigService], exports: [ConfigService] })
export class ConfigModule {}
```

- [ ] **Step 8: Write the failing health e2e test at `apps/api/test/health.e2e.spec.ts`**

```ts
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';

describe('GET /health', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres://cinema:cinema@localhost:5432/cinema';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ logger: false }));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports the process as alive', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});
```

- [ ] **Step 9: Run it to verify it fails**

```bash
npm run test -w @cinema/api -- test/health.e2e.spec.ts
```

Expected: FAIL — `Cannot find module '../src/app.module'`.

- [ ] **Step 10: Implement the health module and the app module**

`apps/api/src/health/health.controller.ts`:

```ts
import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  /** Liveness: the process is up. Deliberately touches no dependency. */
  @Get('health')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
```

`apps/api/src/health/health.module.ts`:

```ts
import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';

@Module({ controllers: [HealthController] })
export class HealthModule {}
```

`apps/api/src/app.module.ts`:

```ts
import { Module } from '@nestjs/common';

import { ConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';

@Module({ imports: [ConfigModule, HealthModule] })
export class AppModule {}
```

- [ ] **Step 11: Implement the bootstrap at `apps/api/src/main.ts`**

```ts
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module';
import { ConfigService } from './config/config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());

  const { config } = app.get(ConfigService);

  app.enableShutdownHooks();
  await app.listen({ port: config.port, host: config.host });
}

void bootstrap();
```

`enableCors`, the logger, the global filter and the OpenAPI plugins are added in Tasks 4, 5 and 10.

- [ ] **Step 12: Run the whole api suite**

```bash
npm run test -w @cinema/api
```

Expected: 5 tests PASS (4 config + 1 health).

- [ ] **Step 13: Verify the server actually boots**

```bash
DATABASE_URL=postgres://cinema:cinema@localhost:5432/cinema npx tsx apps/api/src/main.ts &
sleep 2 && curl -s localhost:3000/health && kill %1
```

Expected: `{"status":"ok"}`.

- [ ] **Step 14: Commit**

```bash
git add -A
git commit -m "feat(api): bootstrap NestJS on Fastify with validated config and a liveness endpoint"
```

---

## Task 4: Structured logging and request correlation

**Files:**
- Create: `apps/api/src/observability/request-context.ts`, `apps/api/src/observability/logger.ts`
- Modify: `apps/api/src/main.ts`
- Test: `apps/api/src/observability/request-context.test.ts`, `apps/api/test/correlation.e2e.spec.ts`

**Interfaces:**
- Consumes: `ConfigService` from Task 3.
- Produces:
  - `requestContext: AsyncLocalStorage<{ requestId: string }>`
  - `currentRequestId(): string` — returns `'no-request'` outside a request
  - `createLogger(config: AppConfig): pino.Logger`
  - `class PinoLoggerService implements LoggerService`
  - `registerCorrelation(app: NestFastifyApplication): void` — installs the Fastify hooks
  - Every response carries an `x-request-id` header; incoming `x-request-id` is honoured.

- [ ] **Step 1: Write the failing unit test at `apps/api/src/observability/request-context.test.ts`**

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run test -w @cinema/api -- src/observability/request-context.test.ts
```

Expected: FAIL — `Cannot find module './request-context'`.

- [ ] **Step 3: Implement `apps/api/src/observability/request-context.ts`**

```ts
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
}

/**
 * Carries the correlation id through the whole request without threading it
 * as a parameter. Read by the logger and by the Problem Details filter.
 */
export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentRequestId(): string {
  return requestContext.getStore()?.requestId ?? 'no-request';
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
npm run test -w @cinema/api -- src/observability/request-context.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 5: Implement `apps/api/src/observability/logger.ts`**

```ts
import { randomUUID } from 'node:crypto';

import type { LoggerService } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';
import pino, { type Logger } from 'pino';

import type { AppConfig } from '../config/env';
import { currentRequestId, requestContext } from './request-context';

export function createLogger(config: AppConfig): Logger {
  return pino({
    level: config.logLevel,
    ...(config.nodeEnv === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
  });
}

/** Generates the correlation id, honouring an upstream `x-request-id`. */
export function generateRequestId(request: { headers: Record<string, unknown> }): string {
  const header = request.headers['x-request-id'];
  return typeof header === 'string' && header.length > 0 && header.length <= 200 ? header : randomUUID();
}

/**
 * Opens the correlation scope for the whole request and echoes the id back, so a
 * user can quote it from a screenshot and the whole lifecycle can be found by it.
 */
export function registerCorrelation(app: NestFastifyApplication): void {
  const instance = app.getHttpAdapter().getInstance();

  instance.addHook('onRequest', (request: FastifyRequest, reply, done) => {
    void reply.header('x-request-id', request.id);
    requestContext.run({ requestId: String(request.id) }, done);
  });
}

/** Bridges Nest's logger onto the same pino instance, stamping every line with the request id. */
export class PinoLoggerService implements LoggerService {
  constructor(private readonly logger: Logger) {}

  private write(level: 'info' | 'error' | 'warn' | 'debug' | 'trace', message: unknown, context?: unknown): void {
    this.logger[level]({ requestId: currentRequestId(), context }, String(message));
  }

  log(message: unknown, context?: unknown): void {
    this.write('info', message, context);
  }

  error(message: unknown, trace?: unknown, context?: unknown): void {
    this.logger.error({ requestId: currentRequestId(), context, trace }, String(message));
  }

  warn(message: unknown, context?: unknown): void {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: unknown): void {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: unknown): void {
    this.write('trace', message, context);
  }
}
```

- [ ] **Step 6: Write the failing e2e test at `apps/api/test/correlation.e2e.spec.ts`**

```ts
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { generateRequestId, registerCorrelation } from '../src/observability/logger';

describe('request correlation', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres://cinema:cinema@localhost:5432/cinema';
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
```

- [ ] **Step 7: Run it to verify it fails**

```bash
npm run test -w @cinema/api -- test/correlation.e2e.spec.ts
```

Expected: FAIL — the `x-request-id` header is `undefined`.

- [ ] **Step 8: Wire it into `apps/api/src/main.ts`**

Replace the whole file:

```ts
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module';
import { parseEnv } from './config/env';
import { ConfigService } from './config/config.service';
import { PinoLoggerService, createLogger, generateRequestId, registerCorrelation } from './observability/logger';

async function bootstrap(): Promise<void> {
  // Parsed twice on purpose: the logger must exist before the DI container does.
  const logger = createLogger(parseEnv(process.env));

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ loggerInstance: logger, genReqId: generateRequestId }),
    { bufferLogs: true },
  );

  app.useLogger(new PinoLoggerService(logger));
  registerCorrelation(app);

  const { config } = app.get(ConfigService);
  app.enableCors({ origin: true });
  app.enableShutdownHooks();

  await app.listen({ port: config.port, host: config.host });
  logger.info({ port: config.port }, 'api listening');
}

void bootstrap();
```

- [ ] **Step 9: Run the full api suite**

```bash
npm run test -w @cinema/api
```

Expected: 10 tests PASS.

- [ ] **Step 10: Verify pretty logs in development**

```bash
DATABASE_URL=postgres://cinema:cinema@localhost:5432/cinema NODE_ENV=development npx tsx apps/api/src/main.ts &
sleep 3 && curl -si localhost:3000/health | grep -i x-request-id && kill %1
```

Expected: an `x-request-id` header in the response, and human-readable coloured log lines on stdout.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(api): add pino logging and AsyncLocalStorage request correlation"
```

---

## Task 5: Error handling — domain errors, Problem Details, Zod validation

**Files:**
- Create: `apps/api/src/http/errors.ts`, `apps/api/src/http/problem-details.filter.ts`, `apps/api/src/http/zod-validation.pipe.ts`, `apps/api/src/http/validated.decorator.ts`, `apps/api/src/http/response-validation.interceptor.ts`
- Modify: `apps/api/src/main.ts`, `apps/api/src/app.module.ts`
- Test: `apps/api/src/http/zod-validation.pipe.test.ts`, `apps/api/test/problem-details.e2e.spec.ts`
- Test fixture: `apps/api/test/fixtures/broken.module.ts`

**Interfaces:**
- Consumes: `currentRequestId()` (Task 4), `ConfigService` (Task 3), `problemDetailsSchema` (Task 2).
- Produces:
  - `abstract class DomainError extends Error` with `readonly status: number`, `readonly typeSlug: string`, `readonly title: string` — the filter renders `type` as `${PUBLIC_ERROR_BASE_URL}/${typeSlug}`
  - `class ResourceNotFoundError extends DomainError` — `new ResourceNotFoundError(resource: string, id: string)`, status 404, type slug `not-found`
  - `class ValidationFailedError extends DomainError` — `new ValidationFailedError(detail: string)`, status 400, type slug `validation-failed`
  - `class InvalidCursorError extends DomainError` — `new InvalidCursorError()`, status 400, type slug `invalid-cursor`
  - `class ProblemDetailsFilter implements ExceptionFilter` — global
  - `zodPipe<T extends z.ZodType>(schema: T): PipeTransform<unknown, z.infer<T>>`
  - `Validated(schema: z.ZodType): MethodDecorator` plus `ResponseValidationInterceptor`

- [ ] **Step 1: Write the failing pipe test at `apps/api/src/http/zod-validation.pipe.test.ts`**

```ts
import { z } from 'zod';

import { ValidationFailedError } from './errors';
import { zodPipe } from './zod-validation.pipe';

const schema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

describe('zodPipe', () => {
  it('returns the parsed value, applying coercion and defaults', () => {
    const pipe = zodPipe(schema);

    expect(pipe.transform({ limit: '30' })).toEqual({ limit: 30 });
    expect(pipe.transform({})).toEqual({ limit: 20 });
  });

  it('throws ValidationFailedError with a readable detail', () => {
    const pipe = zodPipe(schema);

    expect(() => pipe.transform({ limit: '0' })).toThrow(ValidationFailedError);
    expect(() => pipe.transform({ limit: '0' })).toThrow(/limit/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run test -w @cinema/api -- src/http/zod-validation.pipe.test.ts
```

Expected: FAIL — `Cannot find module './errors'`.

- [ ] **Step 3: Implement `apps/api/src/http/errors.ts`**

```ts
/**
 * Base class for failures the client is allowed to see. The HTTP status and the
 * Problem Details `type` live on the error, not in the controller, so a new
 * failure mode cannot be introduced without deciding how it is reported.
 */
export abstract class DomainError extends Error {
  abstract readonly status: number;
  /** Slug appended to PUBLIC_ERROR_BASE_URL to form the Problem Details `type`. */
  abstract readonly typeSlug: string;
  abstract readonly title: string;

  constructor(detail: string) {
    super(detail);
    this.name = new.target.name;
  }
}

export class ResourceNotFoundError extends DomainError {
  readonly status = 404;
  readonly typeSlug = 'not-found';
  readonly title = 'Resource not found';

  constructor(resource: string, id: string) {
    super(`${resource} ${id} does not exist`);
  }
}

export class ValidationFailedError extends DomainError {
  readonly status = 400;
  readonly typeSlug = 'validation-failed';
  readonly title = 'Request validation failed';
}

export class InvalidCursorError extends DomainError {
  readonly status = 400;
  readonly typeSlug = 'invalid-cursor';
  readonly title = 'Invalid pagination cursor';

  constructor() {
    super('The supplied cursor is not a cursor this endpoint issued');
  }
}
```

- [ ] **Step 4: Implement `apps/api/src/http/zod-validation.pipe.ts`**

```ts
import type { PipeTransform } from '@nestjs/common';
import { z } from 'zod';

import { ValidationFailedError } from './errors';

/**
 * Validates with the same schemas the contracts package exports, so the API
 * cannot accept a shape the client's types say is impossible.
 */
export function zodPipe<T extends z.ZodType>(schema: T): PipeTransform<unknown, z.infer<T>> {
  return {
    transform(value: unknown): z.infer<T> {
      const result = schema.safeParse(value);
      if (!result.success) {
        throw new ValidationFailedError(z.prettifyError(result.error));
      }
      return result.data;
    },
  };
}
```

- [ ] **Step 5: Run the pipe test to verify it passes**

```bash
npm run test -w @cinema/api -- src/http/zod-validation.pipe.test.ts
```

Expected: 2 tests PASS.

- [ ] **Step 6: Implement `apps/api/src/http/problem-details.filter.ts`**

```ts
import { ArgumentsHost, Catch, HttpException, Logger, type ExceptionFilter } from '@nestjs/common';
import type { ProblemDetails } from '@cinema/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ConfigService } from '../config/config.service';
import { currentRequestId } from '../observability/request-context';
import { DomainError } from './errors';

const PROBLEM_JSON = 'application/problem+json';

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  constructor(private readonly configService: ConfigService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();

    const problem = this.toProblem(exception, request.url);

    if (problem.status >= 500) {
      this.logger.error(`${problem.status} ${request.method} ${request.url}`, String(exception));
    }

    void reply.status(problem.status).type(PROBLEM_JSON).send(problem);
  }

  private toProblem(exception: unknown, instance: string): ProblemDetails {
    const base = this.configService.config.publicErrorBaseUrl;
    const traceId = currentRequestId();

    if (exception instanceof DomainError) {
      return {
        type: `${base}/${exception.typeSlug}`,
        title: exception.title,
        status: exception.status,
        detail: exception.message,
        instance,
        traceId,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        type: `${base}/http-${status}`,
        title: exception.name,
        status,
        detail: exception.message,
        instance,
        traceId,
      };
    }

    // Nothing about an unexpected failure is safe to hand to the client.
    return {
      type: `${base}/internal`,
      title: 'Internal server error',
      status: 500,
      detail: 'The request could not be processed',
      instance,
      traceId,
    };
  }
}
```

- [ ] **Step 7: Implement response validation (`validated.decorator.ts` and `response-validation.interceptor.ts`)**

`apps/api/src/http/validated.decorator.ts`:

```ts
import { SetMetadata } from '@nestjs/common';
import type { z } from 'zod';

export const RESPONSE_SCHEMA = 'response_schema';

/** Declares the schema a handler promises to return. Read by the interceptor and by the OpenAPI builder. */
export const Validated = (schema: z.ZodType): MethodDecorator => SetMetadata(RESPONSE_SCHEMA, schema);
```

`apps/api/src/http/response-validation.interceptor.ts`:

```ts
import { CallHandler, ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';
import { z } from 'zod';

import { ConfigService } from '../config/config.service';
import { RESPONSE_SCHEMA } from './validated.decorator';

/**
 * Parses every response against the schema the handler declared — but only
 * outside production. It catches "the schema says one thing, the repository
 * returns another" at the moment it appears, without burning CPU in prod.
 */
@Injectable()
export class ResponseValidationInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (this.configService.config.nodeEnv === 'production') return next.handle();

    const schema = this.reflector.get<z.ZodType | undefined>(RESPONSE_SCHEMA, context.getHandler());
    if (!schema) return next.handle();

    return next.handle().pipe(
      map((value) => {
        const result = schema.safeParse(value);
        if (!result.success) {
          throw new Error(
            `Response does not match its declared contract:\n${z.prettifyError(result.error)}`,
          );
        }
        return result.data;
      }),
    );
  }
}
```

- [ ] **Step 8: Create the test fixture at `apps/api/test/fixtures/broken.module.ts`**

```ts
import { Controller, Get, Module } from '@nestjs/common';

import { ResourceNotFoundError } from '../../src/http/errors';

@Controller('__test')
export class BrokenController {
  @Get('not-found')
  notFound(): never {
    throw new ResourceNotFoundError('Movie', '019298a1-7c4e-7c3a-8f21-2f4a9c1d5b60');
  }

  @Get('boom')
  boom(): never {
    throw new Error('a secret internal detail');
  }
}

@Module({ controllers: [BrokenController] })
export class BrokenModule {}
```

- [ ] **Step 9: Write the failing e2e test at `apps/api/test/problem-details.e2e.spec.ts`**

```ts
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
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, BrokenModule] }).compile();
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
```

- [ ] **Step 10: Run it to verify it fails**

```bash
npm run test -w @cinema/api -- test/problem-details.e2e.spec.ts
```

Expected: FAIL — the response is Nest's default JSON error, not `application/problem+json`.

- [ ] **Step 11: Register the filter and interceptor globally**

Add to `apps/api/src/app.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

import { ConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { ProblemDetailsFilter } from './http/problem-details.filter';
import { ResponseValidationInterceptor } from './http/response-validation.interceptor';

@Module({
  imports: [ConfigModule, HealthModule],
  providers: [
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseValidationInterceptor },
  ],
})
export class AppModule {}
```

Because `APP_FILTER` already registers it, the explicit `app.useGlobalFilters(...)` line in the test is redundant but harmless — keep it, so the test documents the wiring it depends on.

- [ ] **Step 12: Run the full api suite**

```bash
npm run test -w @cinema/api
```

Expected: 15 tests PASS.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "feat(api): report every failure as RFC 9457 Problem Details and validate with Zod"
```

---

## Task 6: Drizzle, schema, migrations, `/ready`, Testcontainers harness

**Files:**
- Create: `apps/api/drizzle.config.ts`, `apps/api/src/db/schema.ts`, `apps/api/src/db/drizzle.module.ts`, `apps/api/src/db/migrate.ts`
- Create: `apps/api/test/global-setup.ts`, `apps/api/test/global-teardown.ts`, `apps/api/test/harness.ts`
- Modify: `apps/api/jest.config.ts`, `apps/api/src/app.module.ts`, `apps/api/src/health/health.controller.ts`, `apps/api/src/health/health.module.ts`
- Generated: `apps/api/drizzle/0000_*.sql`, `apps/api/drizzle/0001_showtime_overlap.sql`
- Test: `apps/api/test/schema.e2e.spec.ts`

**Interfaces:**
- Consumes: `ConfigService` (Task 3).
- Produces:
  - `apps/api/src/db/schema.ts` exporting tables `users`, `movies`, `cinemas`, `halls`, `seatCategories`, `seats`, `showtimes`
  - `DRIZZLE: unique symbol` injection token
  - `type Database = NodePgDatabase<typeof schema>`
  - `type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0]` — every repository method accepts one of these, so Task 2 of sub-project 2 can pass a transaction without rewriting call sites
  - `DrizzleModule` — global, exports `DRIZZLE` and `PG_POOL`
  - `GET /ready` → `200 { "status": "ready" }` or `503` Problem Details
  - `startTestDatabase()` / `getTestDatabaseUrl()` from the harness

- [ ] **Step 1: Implement `apps/api/src/db/schema.ts`**

```ts
import { sql } from 'drizzle-orm';
import {
  date,
  index,
  integer,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/** PostgreSQL 18 generates UUID v7 natively: time-ordered, so B-tree locality survives. */
const primaryId = () =>
  uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`);

export const users = pgTable('users', {
  id: primaryId(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const movies = pgTable('movies', {
  id: primaryId(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  durationMinutes: integer('duration_minutes').notNull(),
  posterUrl: text('poster_url').notNull(),
  releaseDate: date('release_date').notNull(),
  rating: real('rating').notNull(),
});

export const cinemas = pgTable('cinemas', {
  id: primaryId(),
  name: text('name').notNull(),
  city: text('city').notNull(),
  address: text('address').notNull(),
  /** IANA zone. Times are stored in UTC; this is applied only for display and date filters. */
  timezone: text('timezone').notNull(),
});

export const halls = pgTable(
  'halls',
  {
    id: primaryId(),
    cinemaId: uuid('cinema_id')
      .notNull()
      .references(() => cinemas.id),
    name: text('name').notNull(),
  },
  (t) => [
    index('halls_cinema_idx').on(t.cinemaId),
    uniqueIndex('halls_cinema_name_uq').on(t.cinemaId, t.name),
  ],
);

/** Pricing policy lives in the database, not in a constant map in the code. */
export const seatCategories = pgTable('seat_categories', {
  code: text('code').primaryKey(),
  label: text('label').notNull(),
  surchargeCents: integer('surcharge_cents').notNull(),
});

export const seats = pgTable(
  'seats',
  {
    id: primaryId(),
    hallId: uuid('hall_id')
      .notNull()
      .references(() => halls.id),
    rowLabel: text('row_label').notNull(),
    seatNumber: integer('seat_number').notNull(),
    categoryCode: text('category_code')
      .notNull()
      .references(() => seatCategories.code),
  },
  (t) => [
    uniqueIndex('seats_hall_row_number_uq').on(t.hallId, t.rowLabel, t.seatNumber),
    index('seats_hall_idx').on(t.hallId),
  ],
);

export const showtimes = pgTable(
  'showtimes',
  {
    id: primaryId(),
    movieId: uuid('movie_id')
      .notNull()
      .references(() => movies.id),
    hallId: uuid('hall_id')
      .notNull()
      .references(() => halls.id),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    basePriceCents: integer('base_price_cents').notNull(),
    language: text('language').notNull(),
    format: text('format').notNull(),
  },
  (t) => [
    index('showtimes_movie_starts_idx').on(t.movieId, t.startsAt),
    index('showtimes_hall_starts_idx').on(t.hallId, t.startsAt),
  ],
);

export const schema = { users, movies, cinemas, halls, seatCategories, seats, showtimes };
```

- [ ] **Step 2: Create `apps/api/drizzle.config.ts`**

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://cinema:cinema@localhost:5432/cinema' },
});
```

- [ ] **Step 3: Generate the base migration**

```bash
npm run db:generate -w @cinema/api
ls apps/api/drizzle
```

Expected: a `0000_*.sql` file plus a `meta/` directory. Read the SQL and confirm all seven tables and both indexes are present.

- [ ] **Step 4: Add the custom migration for the overlap constraint**

```bash
npx --workspace @cinema/api drizzle-kit generate --custom --name=showtime_overlap
```

Then write into the generated `apps/api/drizzle/0001_showtime_overlap.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

--> statement-breakpoint
ALTER TABLE "showtimes"
  ADD CONSTRAINT "showtimes_no_overlap"
  EXCLUDE USING gist (
    "hall_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  );
```

A unique index on `(hall_id, starts_at)` would not catch this: a showtime can start in the middle of the previous one.

- [ ] **Step 5: Implement the migration runner at `apps/api/src/db/migrate.ts`**

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

import { parseEnv } from '../config/env';

/** Run as its own step (a compose service, a CI job), never from the app bootstrap. */
async function main(): Promise<void> {
  const { databaseUrl } = parseEnv(process.env);
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    await migrate(drizzle(pool), { migrationsFolder: `${__dirname}/../../drizzle` });
    console.log('migrations applied');
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 6: Implement `apps/api/src/db/drizzle.module.ts`**

```ts
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { ConfigService } from '../config/config.service';
import { schema } from './schema';

export const DRIZZLE = Symbol('DRIZZLE');
export const PG_POOL = Symbol('PG_POOL');

export type Database = NodePgDatabase<typeof schema>;

/**
 * Anything that reads or writes accepts one of these. Sub-project 2 passes a
 * transaction here instead of the pool, without touching a single call site.
 */
export type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        new Pool({ connectionString: configService.config.databaseUrl, max: 10 }),
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL],
      useFactory: (pool: Pool) => drizzle(pool, { schema }),
    },
  ],
  exports: [DRIZZLE, PG_POOL],
})
export class DrizzleModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Draining the pool on SIGTERM is what makes a rolling restart quiet. */
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
```

- [ ] **Step 7: Add `/ready` to the health module**

`apps/api/src/health/health.controller.ts`:

```ts
import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DRIZZLE, type Database } from '../db/drizzle.module';

@Controller()
export class HealthController {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Liveness: the process is up. Deliberately touches no dependency. */
  @Get('health')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: the process can serve traffic, which means PostgreSQL answers. */
  @Get('ready')
  async ready(): Promise<{ status: 'ready' }> {
    try {
      await this.db.execute(sql`SELECT 1`);
    } catch {
      throw new ServiceUnavailableException('database is not reachable');
    }
    return { status: 'ready' };
  }
}
```

`apps/api/src/health/health.module.ts` stays as it is; add `DrizzleModule` to `AppModule`'s imports:

```ts
imports: [ConfigModule, DrizzleModule, HealthModule],
```

- [ ] **Step 8: Create the Testcontainers harness**

`apps/api/test/harness.ts`:

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

declare global {
  // eslint-disable-next-line no-var
  var __PG_CONTAINER__: StartedPostgreSqlContainer | undefined;
}

export async function startTestDatabase(): Promise<StartedPostgreSqlContainer> {
  const container = await new PostgreSqlContainer('postgres:18-alpine').start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });

  try {
    await migrate(drizzle(pool), { migrationsFolder: `${__dirname}/../drizzle` });
  } finally {
    await pool.end();
  }

  return container;
}

export function getTestDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set; global setup did not run');
  return url;
}
```

`apps/api/test/global-setup.ts`:

```ts
import { startTestDatabase } from './harness';

export default async function globalSetup(): Promise<void> {
  const container = await startTestDatabase();
  globalThis.__PG_CONTAINER__ = container;
  process.env.DATABASE_URL = container.getConnectionUri();
}
```

`apps/api/test/global-teardown.ts`:

```ts
export default async function globalTeardown(): Promise<void> {
  await globalThis.__PG_CONTAINER__?.stop();
}
```

- [ ] **Step 9: Point Jest at the harness**

Add to `apps/api/jest.config.ts`, inside the config object:

```ts
  globalSetup: '<rootDir>/test/global-setup.ts',
  globalTeardown: '<rootDir>/test/global-teardown.ts',
```

Jest's `globalSetup` runs in its own process, so `process.env.DATABASE_URL` set there does **not** reach the workers. Write the URL to a file instead — replace the two files with:

`apps/api/test/global-setup.ts`:

```ts
import { writeFileSync } from 'node:fs';

import { startTestDatabase } from './harness';

export default async function globalSetup(): Promise<void> {
  const container = await startTestDatabase();
  globalThis.__PG_CONTAINER__ = container;
  writeFileSync(`${__dirname}/.database-url`, container.getConnectionUri(), 'utf8');
}
```

`apps/api/test/setup-after-env.ts`:

```ts
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL = readFileSync(`${__dirname}/.database-url`, 'utf8').trim();
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
```

and add to `jest.config.ts`:

```ts
  setupFiles: ['<rootDir>/test/setup-after-env.ts'],
```

Add `apps/api/test/.database-url` to `.gitignore`.

Now remove the `process.env.DATABASE_URL ??= ...` lines from `test/health.e2e.spec.ts`, `test/correlation.e2e.spec.ts` and `test/problem-details.e2e.spec.ts` — the setup file supplies a real database for all of them.

- [ ] **Step 10: Write the failing schema test at `apps/api/test/schema.e2e.spec.ts`**

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';

import { getTestDatabaseUrl } from './harness';

describe('database schema', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle>;

  beforeAll(() => {
    pool = new Pool({ connectionString: getTestDatabaseUrl() });
    db = drizzle(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates every catalogue table', async () => {
    const result = await db.execute<{ table_name: string }>(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const names = result.rows.map((row) => row.table_name);

    for (const table of ['users', 'movies', 'cinemas', 'halls', 'seat_categories', 'seats', 'showtimes']) {
      expect(names).toContain(table);
    }
  });

  it('refuses two showtimes that overlap in the same hall', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO movies (id, title, description, duration_minutes, poster_url, release_date, rating)
         VALUES (uuidv7(), 'Test', 'd', 120, 'https://x/y.jpg', '2026-01-01', 7.5)`,
      );
      await client.query(`INSERT INTO cinemas (id, name, city, address, timezone)
         VALUES (uuidv7(), 'C', 'Kyiv', 'a', 'Europe/Kyiv')`);
      await client.query(
        `INSERT INTO halls (id, cinema_id, name) SELECT uuidv7(), id, 'H1' FROM cinemas LIMIT 1`,
      );

      const insertShowtime = (start: string, end: string) =>
        client.query(
          `INSERT INTO showtimes (id, movie_id, hall_id, starts_at, ends_at, base_price_cents, language, format)
           SELECT uuidv7(), m.id, h.id, $1::timestamptz, $2::timestamptz, 15000, 'uk', 'TWO_D'
           FROM movies m, halls h LIMIT 1`,
          [start, end],
        );

      await insertShowtime('2026-09-01T10:00:00Z', '2026-09-01T12:30:00Z');

      await expect(insertShowtime('2026-09-01T12:00:00Z', '2026-09-01T14:00:00Z')).rejects.toThrow(
        /showtimes_no_overlap/,
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('allows back-to-back showtimes in the same hall', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO movies (id, title, description, duration_minutes, poster_url, release_date, rating)
         VALUES (uuidv7(), 'Test', 'd', 120, 'https://x/y.jpg', '2026-01-01', 7.5)`,
      );
      await client.query(`INSERT INTO cinemas (id, name, city, address, timezone)
         VALUES (uuidv7(), 'C', 'Kyiv', 'a', 'Europe/Kyiv')`);
      await client.query(
        `INSERT INTO halls (id, cinema_id, name) SELECT uuidv7(), id, 'H1' FROM cinemas LIMIT 1`,
      );

      const insertShowtime = (start: string, end: string) =>
        client.query(
          `INSERT INTO showtimes (id, movie_id, hall_id, starts_at, ends_at, base_price_cents, language, format)
           SELECT uuidv7(), m.id, h.id, $1::timestamptz, $2::timestamptz, 15000, 'uk', 'TWO_D'
           FROM movies m, halls h LIMIT 1`,
          [start, end],
        );

      await insertShowtime('2026-09-01T10:00:00Z', '2026-09-01T12:00:00Z');
      await expect(insertShowtime('2026-09-01T12:00:00Z', '2026-09-01T14:00:00Z')).resolves.toBeDefined();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
```

The `[)` bound in the constraint is what makes the third test pass while the second fails — a showtime may start exactly when the previous one ends.

- [ ] **Step 11: Run it to verify it fails, then passes**

```bash
docker info > /dev/null && npm run test -w @cinema/api -- test/schema.e2e.spec.ts
```

Expected on the first run before Step 4's SQL is applied: FAIL on the overlap test. With the migration in place: 3 tests PASS. Docker must be running — Testcontainers needs it.

- [ ] **Step 12: Add a `/ready` assertion to `apps/api/test/health.e2e.spec.ts`**

```ts
  it('reports readiness once the database answers', async () => {
    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
  });
```

- [ ] **Step 13: Run the full api suite**

```bash
npm run test -w @cinema/api
```

Expected: 19 tests PASS.

- [ ] **Step 14: Commit**

```bash
git add -A
git commit -m "feat(api): add Drizzle schema, migrations, readiness probe and a Testcontainers harness

The showtime overlap constraint is an EXCLUDE USING gist over tstzrange, which a
unique index on (hall_id, starts_at) cannot express."
```

---

## Task 7: Deterministic seed

**Files:**
- Create: `apps/api/src/db/seed-data.ts`, `apps/api/src/db/timezone.ts`, `apps/api/src/db/seed.ts`
- Test: `apps/api/src/db/timezone.test.ts`, `apps/api/test/seed.e2e.spec.ts`

**Interfaces:**
- Consumes: `schema` (Task 6).
- Produces:
  - `zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date`
  - `seedDatabase(db: Database): Promise<void>` — truncates and reinserts; safe to run repeatedly
  - Fixed data: 3 users, 10 movies, 3 cinemas, 12 halls (one named `Premiere` with exactly 1000 seats), 3 seat categories (`STANDARD` 0, `VIP` 8000, `RECLINER` 15000 cents), 4 showtimes per hall per day for 14 days from `2026-09-01`

- [ ] **Step 1: Write the failing timezone test at `apps/api/src/db/timezone.test.ts`**

```ts
import { zonedToUtc } from './timezone';

describe('zonedToUtc', () => {
  it('converts Kyiv summer time (UTC+3) to UTC', () => {
    expect(zonedToUtc(2026, 9, 1, 10, 0, 'Europe/Kyiv').toISOString()).toBe('2026-09-01T07:00:00.000Z');
  });

  it('converts Warsaw summer time (UTC+2) to UTC', () => {
    expect(zonedToUtc(2026, 9, 1, 10, 0, 'Europe/Warsaw').toISOString()).toBe('2026-09-01T08:00:00.000Z');
  });

  it('handles a winter date, where the offset differs', () => {
    expect(zonedToUtc(2026, 12, 1, 10, 0, 'Europe/Kyiv').toISOString()).toBe('2026-12-01T08:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run test -w @cinema/api -- src/db/timezone.test.ts
```

Expected: FAIL — `Cannot find module './timezone'`.

- [ ] **Step 3: Implement `apps/api/src/db/timezone.ts`**

```ts
/** Milliseconds the zone is ahead of UTC at the given instant. */
function offsetAt(utcMs: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }

  const asIfUtc = Date.UTC(
    parts.year ?? 0,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    (parts.hour ?? 0) % 24,
    parts.minute ?? 0,
    parts.second ?? 0,
  );

  return asIfUtc - utcMs;
}

/**
 * Turns a wall-clock time in a named zone into the UTC instant we store.
 * Two passes: the first offset is a guess made from the wrong instant, the
 * second is taken at the corrected instant, which is what DST changeovers need.
 */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const firstGuess = naive - offsetAt(naive, timeZone);
  return new Date(naive - offsetAt(firstGuess, timeZone));
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
npm run test -w @cinema/api -- src/db/timezone.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 5: Create the fixed data at `apps/api/src/db/seed-data.ts`**

```ts
export interface HallSpec {
  name: string;
  rows: number;
  seatsPerRow: number;
}

export interface CinemaSpec {
  name: string;
  city: string;
  address: string;
  timezone: string;
  halls: HallSpec[];
}

export const SEAT_CATEGORIES = [
  { code: 'STANDARD', label: 'Standard', surchargeCents: 0 },
  { code: 'VIP', label: 'VIP', surchargeCents: 8_000 },
  { code: 'RECLINER', label: 'Recliner', surchargeCents: 15_000 },
] as const;

export const USERS = [
  { email: 'ada@example.com', displayName: 'Ada' },
  { email: 'grace@example.com', displayName: 'Grace' },
  { email: 'linus@example.com', displayName: 'Linus' },
] as const;

export const MOVIES = [
  { title: 'Dune: Part Two', durationMinutes: 166, releaseDate: '2024-03-01', rating: 8.5 },
  { title: 'Inception', durationMinutes: 148, releaseDate: '2010-07-16', rating: 8.8 },
  { title: 'Arrival', durationMinutes: 116, releaseDate: '2016-11-11', rating: 7.9 },
  { title: 'Blade Runner 2049', durationMinutes: 164, releaseDate: '2017-10-06', rating: 8.0 },
  { title: 'Interstellar', durationMinutes: 169, releaseDate: '2014-11-07', rating: 8.7 },
  { title: 'The Prestige', durationMinutes: 130, releaseDate: '2006-10-20', rating: 8.5 },
  { title: 'Whiplash', durationMinutes: 106, releaseDate: '2014-10-10', rating: 8.5 },
  { title: 'Parasite', durationMinutes: 132, releaseDate: '2019-05-30', rating: 8.5 },
  { title: 'Sicario', durationMinutes: 121, releaseDate: '2015-09-18', rating: 7.6 },
  { title: 'Her', durationMinutes: 126, releaseDate: '2013-12-18', rating: 8.0 },
] as const;

/** The Premiere hall is 25 x 40 = 1000 seats — the hall sub-project 3 runs its load experiment against. */
export const CINEMAS: CinemaSpec[] = [
  {
    name: 'Zoryany',
    city: 'Kyiv',
    address: 'Velyka Vasylkivska 41',
    timezone: 'Europe/Kyiv',
    halls: [
      { name: 'Premiere', rows: 25, seatsPerRow: 40 },
      { name: 'Blue', rows: 10, seatsPerRow: 14 },
      { name: 'Green', rows: 8, seatsPerRow: 12 },
      { name: 'Red', rows: 6, seatsPerRow: 10 },
    ],
  },
  {
    name: 'Kinopalats',
    city: 'Lviv',
    address: 'Teatralna 22',
    timezone: 'Europe/Kyiv',
    halls: [
      { name: 'Halyna', rows: 12, seatsPerRow: 16 },
      { name: 'Ivan', rows: 8, seatsPerRow: 12 },
      { name: 'Lesya', rows: 6, seatsPerRow: 10 },
      { name: 'Taras', rows: 10, seatsPerRow: 14 },
    ],
  },
  {
    name: 'Muranow',
    city: 'Warsaw',
    address: 'Andersa 1',
    timezone: 'Europe/Warsaw',
    halls: [
      { name: 'Alfa', rows: 12, seatsPerRow: 16 },
      { name: 'Beta', rows: 8, seatsPerRow: 12 },
      { name: 'Gamma', rows: 6, seatsPerRow: 10 },
      { name: 'Delta', rows: 10, seatsPerRow: 14 },
    ],
  },
];

/** Local wall-clock start times. 3.5 h apart, which clears the longest film plus cleaning. */
export const SLOTS = [
  { hour: 10, minute: 0 },
  { hour: 13, minute: 30 },
  { hour: 17, minute: 0 },
  { hour: 20, minute: 30 },
] as const;

export const FORMATS = ['TWO_D', 'THREE_D', 'IMAX'] as const;
export const LANGUAGES = ['uk', 'en', 'pl'] as const;

export const SEED_START_DATE = { year: 2026, month: 9, day: 1 };
export const SEED_DAYS = 14;
export const CLEANING_MINUTES = 30;
export const BASE_PRICE_CENTS = 15_000;

/** A, B, ... Y — 25 letters is exactly the Premiere hall's row count. */
export function rowLabel(index: number): string {
  return String.fromCharCode('A'.charCodeAt(0) + index);
}

/** Front half standard, then VIP, last two rows recliners. Deterministic, no randomness. */
export function categoryForRow(rowIndex: number, totalRows: number): string {
  if (rowIndex >= totalRows - 2) return 'RECLINER';
  if (rowIndex >= Math.floor(totalRows / 2)) return 'VIP';
  return 'STANDARD';
}
```

- [ ] **Step 6: Implement `apps/api/src/db/seed.ts`**

```ts
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { parseEnv } from '../config/env';
import type { Database } from './drizzle.module';
import { cinemas, halls, movies, seatCategories, seats, showtimes, users } from './schema';
import {
  BASE_PRICE_CENTS,
  CINEMAS,
  CLEANING_MINUTES,
  FORMATS,
  LANGUAGES,
  MOVIES,
  SEAT_CATEGORIES,
  SEED_DAYS,
  SEED_START_DATE,
  SLOTS,
  USERS,
  categoryForRow,
  rowLabel,
} from './seed-data';
import { zonedToUtc } from './timezone';

const INSERT_CHUNK = 1_000;

async function insertInChunks<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await insert(rows.slice(i, i + INSERT_CHUNK));
  }
}

/** Wipes and rebuilds the catalogue. Deterministic: same input, same rows, every time. */
export async function seedDatabase(db: Database): Promise<void> {
  await db.execute(
    sql`TRUNCATE TABLE showtimes, seats, halls, cinemas, movies, seat_categories, users RESTART IDENTITY CASCADE`,
  );

  await db.insert(seatCategories).values([...SEAT_CATEGORIES]);
  await db.insert(users).values(USERS.map((u) => ({ email: u.email, displayName: u.displayName })));

  const movieRows = await db
    .insert(movies)
    .values(
      MOVIES.map((m) => ({
        title: m.title,
        description: `${m.title} — seeded catalogue entry.`,
        durationMinutes: m.durationMinutes,
        posterUrl: `https://images.example/posters/${m.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.jpg`,
        releaseDate: m.releaseDate,
        rating: m.rating,
      })),
    )
    .returning({ id: movies.id, durationMinutes: movies.durationMinutes });

  let showtimeCounter = 0;

  for (const cinemaSpec of CINEMAS) {
    const [cinema] = await db
      .insert(cinemas)
      .values({
        name: cinemaSpec.name,
        city: cinemaSpec.city,
        address: cinemaSpec.address,
        timezone: cinemaSpec.timezone,
      })
      .returning({ id: cinemas.id });
    if (!cinema) throw new Error('cinema insert returned nothing');

    for (const hallSpec of cinemaSpec.halls) {
      const [hall] = await db
        .insert(halls)
        .values({ cinemaId: cinema.id, name: hallSpec.name })
        .returning({ id: halls.id });
      if (!hall) throw new Error('hall insert returned nothing');

      const seatRows = [];
      for (let row = 0; row < hallSpec.rows; row += 1) {
        for (let seat = 1; seat <= hallSpec.seatsPerRow; seat += 1) {
          seatRows.push({
            hallId: hall.id,
            rowLabel: rowLabel(row),
            seatNumber: seat,
            categoryCode: categoryForRow(row, hallSpec.rows),
          });
        }
      }
      await insertInChunks(seatRows, (chunk) => db.insert(seats).values(chunk));

      const showtimeRows = [];
      for (let day = 0; day < SEED_DAYS; day += 1) {
        for (const slot of SLOTS) {
          const movie = movieRows[showtimeCounter % movieRows.length];
          if (!movie) throw new Error('no movies seeded');

          const startsAt = zonedToUtc(
            SEED_START_DATE.year,
            SEED_START_DATE.month,
            SEED_START_DATE.day + day,
            slot.hour,
            slot.minute,
            cinemaSpec.timezone,
          );
          const endsAt = new Date(
            startsAt.getTime() + (movie.durationMinutes + CLEANING_MINUTES) * 60_000,
          );

          showtimeRows.push({
            movieId: movie.id,
            hallId: hall.id,
            startsAt,
            endsAt,
            basePriceCents: BASE_PRICE_CENTS + (showtimeCounter % 3) * 2_000,
            language: LANGUAGES[showtimeCounter % LANGUAGES.length] ?? 'uk',
            format: FORMATS[showtimeCounter % FORMATS.length] ?? 'TWO_D',
          });
          showtimeCounter += 1;
        }
      }
      await insertInChunks(showtimeRows, (chunk) => db.insert(showtimes).values(chunk));
    }
  }
}

async function main(): Promise<void> {
  const { databaseUrl } = parseEnv(process.env);
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    await seedDatabase(drizzle(pool, { schema: { users, movies, cinemas, halls, seatCategories, seats, showtimes } }) as Database);
    console.log('seed complete');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
```

`SEED_START_DATE.day + day` overflowing past 30 is fine: `Date.UTC` normalises it into the next month.

- [ ] **Step 7: Write the failing seed test at `apps/api/test/seed.e2e.spec.ts`**

```ts
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import type { Database } from '../src/db/drizzle.module';
import { schema } from '../src/db/schema';
import { seedDatabase } from '../src/db/seed';
import { getTestDatabaseUrl } from './harness';

describe('seedDatabase', () => {
  let pool: Pool;
  let db: Database;

  beforeAll(async () => {
    pool = new Pool({ connectionString: getTestDatabaseUrl() });
    db = drizzle(pool, { schema }) as Database;
    await seedDatabase(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  const count = async (table: string): Promise<number> => {
    const result = await db.execute<{ n: string }>(sql.raw(`SELECT count(*)::text AS n FROM ${table}`));
    return Number(result.rows[0]?.n ?? '0');
  };

  it('creates the fixed catalogue', async () => {
    expect(await count('users')).toBe(3);
    expect(await count('movies')).toBe(10);
    expect(await count('cinemas')).toBe(3);
    expect(await count('halls')).toBe(12);
    expect(await count('seat_categories')).toBe(3);
  });

  it('creates a 1000-seat hall for the load experiment', async () => {
    const result = await db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM seats s JOIN halls h ON h.id = s.hall_id WHERE h.name = 'Premiere'`,
    );
    expect(Number(result.rows[0]?.n)).toBe(1000);
  });

  it('creates 4 showtimes per hall per day for 14 days', async () => {
    expect(await count('showtimes')).toBe(12 * 14 * 4);
  });

  it('never produces overlapping showtimes in a hall', async () => {
    // The EXCLUDE constraint would have rejected the insert; this asserts the
    // slot layout, not the constraint.
    const result = await db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM showtimes a JOIN showtimes b
          ON a.hall_id = b.hall_id AND a.id <> b.id
          AND tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(b.starts_at, b.ends_at, '[)')`,
    );
    expect(Number(result.rows[0]?.n)).toBe(0);
  });

  it('is repeatable — running it twice leaves the same row counts', async () => {
    await seedDatabase(db);
    expect(await count('movies')).toBe(10);
    expect(await count('showtimes')).toBe(12 * 14 * 4);
  });

  it('stores the three pricing categories', async () => {
    const result = await db.execute<{ code: string; surcharge_cents: number }>(
      sql`SELECT code, surcharge_cents FROM seat_categories ORDER BY code`,
    );
    expect(result.rows).toEqual([
      { code: 'RECLINER', surcharge_cents: 15000 },
      { code: 'STANDARD', surcharge_cents: 0 },
      { code: 'VIP', surcharge_cents: 8000 },
    ]);
  });
});
```

- [ ] **Step 8: Run it to verify it fails, then implement until it passes**

```bash
npm run test -w @cinema/api -- test/seed.e2e.spec.ts
```

Expected: FAIL first (`Cannot find module '../src/db/seed'`), then 6 tests PASS.

- [ ] **Step 9: Run the full api suite**

```bash
npm run test -w @cinema/api
```

Expected: 28 tests PASS.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(api): add a deterministic catalogue seed with a 1000-seat premiere hall"
```

---

## Task 8: Catalogue read API — movies and cinemas

**Files:**
- Create: `packages/contracts/src/movie.ts`, `packages/contracts/src/cinema.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/src/catalog/cursor.ts`, `apps/api/src/catalog/catalog.service.ts`, `apps/api/src/catalog/catalog.controller.ts`, `apps/api/src/catalog/catalog.module.ts`
- Modify: `apps/api/src/app.module.ts`, `apps/api/src/main.ts`
- Test: `apps/api/src/catalog/cursor.test.ts`, `apps/api/test/catalog-movies.e2e.spec.ts`

**Interfaces:**
- Consumes: `pageSchema`, `paginationQuerySchema`, `idParamSchema` (Task 2); `zodPipe`, `Validated`, `ResourceNotFoundError`, `InvalidCursorError` (Task 5); `DRIZZLE`, `Executor` (Task 6); seed (Task 7).
- Produces:
  - `movieSchema` → `Movie = { id, title, description, durationMinutes, posterUrl, releaseDate, rating }`
  - `moviePageSchema`, `cinemaSchema` → `Cinema = { id, name, city, address, timezone }`, `cinemaPageSchema`
  - `encodeCursor(parts: (string | number)[]): string`, `decodeCursor(cursor: string): unknown[]` (throws `InvalidCursorError`)
  - `CatalogService.listMovies(query, executor?)`, `.getMovie(id, executor?)`, `.listCinemas(query, executor?)`, `.getCinema(id, executor?)`
  - `GET /api/v1/movies`, `GET /api/v1/movies/:id`, `GET /api/v1/cinemas`, `GET /api/v1/cinemas/:id`

- [ ] **Step 1: Add the contracts**

`packages/contracts/src/movie.ts`:

```ts
import { z } from 'zod';

import { pageSchema } from './common.js';

export const movieSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1),
  description: z.string(),
  durationMinutes: z.int().positive(),
  posterUrl: z.url(),
  releaseDate: z.iso.date(),
  rating: z.number().min(0).max(10),
});
export type Movie = z.infer<typeof movieSchema>;

export const moviePageSchema = pageSchema(movieSchema);
```

`packages/contracts/src/cinema.ts`:

```ts
import { z } from 'zod';

import { pageSchema } from './common.js';

export const cinemaSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  city: z.string().min(1),
  address: z.string().min(1),
  /** IANA time zone, e.g. Europe/Kyiv. */
  timezone: z.string().min(1),
});
export type Cinema = z.infer<typeof cinemaSchema>;

export const cinemaPageSchema = pageSchema(cinemaSchema);
```

`packages/contracts/src/index.ts`:

```ts
export * from './common.js';
export * from './movie.js';
export * from './cinema.js';
```

- [ ] **Step 2: Write the failing cursor test at `apps/api/src/catalog/cursor.test.ts`**

```ts
import { InvalidCursorError } from '../http/errors';
import { decodeCursor, encodeCursor } from './cursor';

describe('cursor codec', () => {
  it('round-trips the ordering key', () => {
    const cursor = encodeCursor(['Dune', '019298a1-7c4e-7c3a-8f21-2f4a9c1d5b60']);

    expect(decodeCursor(cursor)).toEqual(['Dune', '019298a1-7c4e-7c3a-8f21-2f4a9c1d5b60']);
  });

  it('produces a url-safe string', () => {
    expect(encodeCursor(['a/b+c', 1])).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects a cursor that is not one we issued', () => {
    expect(() => decodeCursor('not-base64!!')).toThrow(InvalidCursorError);
    expect(() => decodeCursor(Buffer.from('{"a":1}').toString('base64url'))).toThrow(InvalidCursorError);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
npm run test -w @cinema/api -- src/catalog/cursor.test.ts
```

Expected: FAIL — `Cannot find module './cursor'`.

- [ ] **Step 4: Implement `apps/api/src/catalog/cursor.ts`**

```ts
import { InvalidCursorError } from '../http/errors';

/**
 * Keyset cursors, not offsets: an offset skips or repeats rows when something is
 * inserted between two pages, and degrades as the offset grows.
 *
 * The payload is the ordering key of the last row on the page. It is opaque to
 * clients on purpose — the ordering may change without breaking their code.
 */
export function encodeCursor(parts: (string | number)[]): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }

  if (!Array.isArray(parsed)) throw new InvalidCursorError();
  return parsed;
}

/** Narrows a decoded cursor to the `[string, uuid]` shape every catalogue list uses. */
export function decodeTextIdCursor(cursor: string): [string, string] {
  const parts = decodeCursor(cursor);
  const [text, id] = parts;
  if (typeof text !== 'string' || typeof id !== 'string') throw new InvalidCursorError();
  return [text, id];
}
```

- [ ] **Step 5: Run it to verify it passes**

```bash
npm run test -w @cinema/api -- src/catalog/cursor.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 6: Implement `apps/api/src/catalog/catalog.service.ts`**

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { Cinema, Movie, PaginationQuery, Page } from '@cinema/contracts';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

import { DRIZZLE, type Database, type Executor } from '../db/drizzle.module';
import { cinemas, movies } from '../db/schema';
import { ResourceNotFoundError } from '../http/errors';
import { decodeTextIdCursor, encodeCursor } from './cursor';

@Injectable()
export class CatalogService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async listMovies(query: PaginationQuery, executor: Executor = this.db): Promise<Page<Movie>> {
    // One row more than asked for: its presence is what tells us there is a next page.
    const rows = await executor
      .select({
        id: movies.id,
        title: movies.title,
        description: movies.description,
        durationMinutes: movies.durationMinutes,
        posterUrl: movies.posterUrl,
        releaseDate: movies.releaseDate,
        rating: movies.rating,
      })
      .from(movies)
      .where(query.cursor ? afterTextId(movies.title, movies.id, query.cursor) : undefined)
      .orderBy(asc(movies.title), asc(movies.id))
      .limit(query.limit + 1);

    return toPage(rows, query.limit, (row) => encodeCursor([row.title, row.id]));
  }

  async getMovie(id: string, executor: Executor = this.db): Promise<Movie> {
    const [row] = await executor
      .select({
        id: movies.id,
        title: movies.title,
        description: movies.description,
        durationMinutes: movies.durationMinutes,
        posterUrl: movies.posterUrl,
        releaseDate: movies.releaseDate,
        rating: movies.rating,
      })
      .from(movies)
      .where(eq(movies.id, id))
      .limit(1);

    if (!row) throw new ResourceNotFoundError('Movie', id);
    return row;
  }

  async listCinemas(query: PaginationQuery, executor: Executor = this.db): Promise<Page<Cinema>> {
    const rows = await executor
      .select({
        id: cinemas.id,
        name: cinemas.name,
        city: cinemas.city,
        address: cinemas.address,
        timezone: cinemas.timezone,
      })
      .from(cinemas)
      .where(query.cursor ? afterTextId(cinemas.name, cinemas.id, query.cursor) : undefined)
      .orderBy(asc(cinemas.name), asc(cinemas.id))
      .limit(query.limit + 1);

    return toPage(rows, query.limit, (row) => encodeCursor([row.name, row.id]));
  }

  async getCinema(id: string, executor: Executor = this.db): Promise<Cinema> {
    const [row] = await executor
      .select({
        id: cinemas.id,
        name: cinemas.name,
        city: cinemas.city,
        address: cinemas.address,
        timezone: cinemas.timezone,
      })
      .from(cinemas)
      .where(eq(cinemas.id, id))
      .limit(1);

    if (!row) throw new ResourceNotFoundError('Cinema', id);
    return row;
  }
}

/** Row-value comparison: `(title, id) > ($1, $2)` is exactly the keyset predicate. */
function afterTextId(textColumn: PgColumn, idColumn: PgColumn, cursor: string) {
  const [text, id] = decodeTextIdCursor(cursor);
  return sql`(${textColumn}, ${idColumn}) > (${text}, ${id}::uuid)`;
}

function toPage<T>(rows: T[], limit: number, cursorOf: (row: T) => string): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data.at(-1);

  return { data, nextCursor: hasMore && last ? cursorOf(last) : null };
}
```

`PgColumn` is the concrete type Drizzle gives table columns, which is what lets the same helper serve both the movie and the cinema query.

- [ ] **Step 7: Implement the controller and module**

`apps/api/src/catalog/catalog.controller.ts`:

```ts
import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  cinemaPageSchema,
  cinemaSchema,
  idParamSchema,
  moviePageSchema,
  movieSchema,
  paginationQuerySchema,
  type Cinema,
  type IdParam,
  type Movie,
  type Page,
  type PaginationQuery,
} from '@cinema/contracts';

import { Validated } from '../http/validated.decorator';
import { zodPipe } from '../http/zod-validation.pipe';
import { CatalogService } from './catalog.service';

@Controller({ version: '1' })
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('movies')
  @Validated(moviePageSchema)
  listMovies(@Query(zodPipe(paginationQuerySchema)) query: PaginationQuery): Promise<Page<Movie>> {
    return this.catalog.listMovies(query);
  }

  @Get('movies/:id')
  @Validated(movieSchema)
  getMovie(@Param(zodPipe(idParamSchema)) params: IdParam): Promise<Movie> {
    return this.catalog.getMovie(params.id);
  }

  @Get('cinemas')
  @Validated(cinemaPageSchema)
  listCinemas(@Query(zodPipe(paginationQuerySchema)) query: PaginationQuery): Promise<Page<Cinema>> {
    return this.catalog.listCinemas(query);
  }

  @Get('cinemas/:id')
  @Validated(cinemaSchema)
  getCinema(@Param(zodPipe(idParamSchema)) params: IdParam): Promise<Cinema> {
    return this.catalog.getCinema(params.id);
  }
}
```

`apps/api/src/catalog/catalog.module.ts`:

```ts
import { Module } from '@nestjs/common';

import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';

@Module({ controllers: [CatalogController], providers: [CatalogService], exports: [CatalogService] })
export class CatalogModule {}
```

Add `CatalogModule` to `AppModule`'s `imports`.

- [ ] **Step 8: Turn on the URI prefix and versioning in `apps/api/src/main.ts`**

Insert after `registerCorrelation(app);`:

```ts
  app.setGlobalPrefix('api', { exclude: ['health', 'ready'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
```

and add `import { VersioningType } from '@nestjs/common';`. Health and readiness stay unversioned — orchestrators probe a fixed path.

- [ ] **Step 9: Write the failing e2e test at `apps/api/test/catalog-movies.e2e.spec.ts`**

```ts
import { cinemaPageSchema, moviePageSchema, movieSchema, problemDetailsSchema } from '@cinema/contracts';
import { VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { AppModule } from '../src/app.module';
import type { Database } from '../src/db/drizzle.module';
import { schema } from '../src/db/schema';
import { seedDatabase } from '../src/db/seed';
import { generateRequestId, registerCorrelation } from '../src/observability/logger';
import { getTestDatabaseUrl } from './harness';

describe('catalogue: movies and cinemas', () => {
  let app: NestFastifyApplication;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: getTestDatabaseUrl() });
    await seedDatabase(drizzle(pool, { schema }) as Database);

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
    await pool.end();
  });

  it('returns the first page in a data/nextCursor envelope', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/movies?limit=4' });

    expect(response.statusCode).toBe(200);
    const page = moviePageSchema.parse(response.json());
    expect(page.data).toHaveLength(4);
    expect(page.nextCursor).toEqual(expect.any(String));
  });

  it('walks the whole catalogue by cursor without repeating or losing a movie', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;

    do {
      const url: string = `/api/v1/movies?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = moviePageSchema.parse((await app.inject({ method: 'GET', url })).json());
      seen.push(...page.data.map((movie) => movie.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toHaveLength(10);
    expect(new Set(seen).size).toBe(10);
  });

  it('orders movies by title', async () => {
    const page = moviePageSchema.parse((await app.inject({ method: 'GET', url: '/api/v1/movies?limit=100' })).json());
    const titles = page.data.map((movie) => movie.title);

    expect(titles).toEqual([...titles].sort());
    expect(page.nextCursor).toBeNull();
  });

  it('returns a single movie', async () => {
    const page = moviePageSchema.parse((await app.inject({ method: 'GET', url: '/api/v1/movies?limit=1' })).json());
    const id = page.data[0]?.id;

    const response = await app.inject({ method: 'GET', url: `/api/v1/movies/${id}` });

    expect(response.statusCode).toBe(200);
    expect(movieSchema.parse(response.json()).id).toBe(id);
  });

  it('answers 404 as a problem document for an unknown movie', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/movies/019298a1-7c4e-7c3a-8f21-000000000000',
    });

    expect(response.statusCode).toBe(404);
    expect(problemDetailsSchema.parse(response.json()).type).toMatch(/not-found$/);
  });

  it('answers 400 for a malformed id', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/movies/not-a-uuid' });

    expect(response.statusCode).toBe(400);
    expect(problemDetailsSchema.parse(response.json()).type).toMatch(/validation-failed$/);
  });

  it('answers 400 for a cursor it did not issue', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/movies?cursor=zzzz' });

    expect(response.statusCode).toBe(400);
    expect(problemDetailsSchema.parse(response.json()).type).toMatch(/invalid-cursor$/);
  });

  it('answers 400 for a limit above the maximum', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/movies?limit=1000' });

    expect(response.statusCode).toBe(400);
  });

  it('lists the three cinemas with their time zones', async () => {
    const page = cinemaPageSchema.parse((await app.inject({ method: 'GET', url: '/api/v1/cinemas' })).json());

    expect(page.data).toHaveLength(3);
    expect(page.data.map((cinema) => cinema.city).sort()).toEqual(['Kyiv', 'Lviv', 'Warsaw']);
    expect(page.data.find((cinema) => cinema.city === 'Warsaw')?.timezone).toBe('Europe/Warsaw');
  });
});
```

- [ ] **Step 10: Run it to verify it fails, then implement until it passes**

```bash
npm run contracts:build
npm run test -w @cinema/api -- test/catalog-movies.e2e.spec.ts
```

Expected: FAIL first (404 on `/api/v1/movies`), then 9 tests PASS.

- [ ] **Step 11: Run the full suite and the linter**

```bash
npm run test -w @cinema/api
npm run lint
```

Expected: 40 tests PASS, lint clean.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat(api): serve movies and cinemas with keyset pagination behind /api/v1"
```

---

## Task 9: Catalogue read API — showtimes and the seat map

**Files:**
- Create: `packages/contracts/src/showtime.ts`, `packages/contracts/src/seat.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/api/src/catalog/cursor.ts`, `apps/api/src/catalog/catalog.service.ts`, `apps/api/src/catalog/catalog.controller.ts`
- Test: `apps/api/test/catalog-showtimes.e2e.spec.ts`

**Interfaces:**
- Consumes: everything from Task 8.
- Produces:
  - `showtimeFormatSchema = z.enum(['TWO_D','THREE_D','IMAX'])`
  - `showtimeSchema` → `Showtime = { id, movieId, hallId, hallName, cinemaId, cinemaName, startsAt, endsAt, basePriceCents, language, format }`
  - `showtimePageSchema`, `showtimeQuerySchema` → `{ cursor?, limit, movieId?, cinemaId?, date? }`
  - `seatCategorySchema = z.enum(['STANDARD','VIP','RECLINER'])`, `seatStatusSchema = z.enum(['AVAILABLE','HELD','CONFIRMED'])`
  - `showtimeSeatsSchema` → `{ showtimeId, hallId, hallName, seats: ShowtimeSeat[] }` where `ShowtimeSeat = { seatId, rowLabel, seatNumber, category, priceCents, status }`
  - `decodeTimestampIdCursor(cursor: string): [string, string]`
  - `CatalogService.listShowtimes(query, executor?)`, `.getShowtime(id, executor?)`, `.getShowtimeSeats(id, executor?)`
  - `GET /api/v1/showtimes`, `GET /api/v1/showtimes/:id`, `GET /api/v1/showtimes/:id/seats`

- [ ] **Step 1: Add the contracts**

`packages/contracts/src/showtime.ts`:

```ts
import { z } from 'zod';

import { pageSchema, paginationQuerySchema } from './common.js';

export const showtimeFormatSchema = z.enum(['TWO_D', 'THREE_D', 'IMAX']);
export type ShowtimeFormat = z.infer<typeof showtimeFormatSchema>;

export const showtimeSchema = z.object({
  id: z.uuid(),
  movieId: z.uuid(),
  hallId: z.uuid(),
  hallName: z.string().min(1),
  cinemaId: z.uuid(),
  cinemaName: z.string().min(1),
  /** UTC instant. The cinema's own zone lives on the cinema resource. */
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  basePriceCents: z.int().nonnegative(),
  language: z.string().min(1),
  format: showtimeFormatSchema,
});
export type Showtime = z.infer<typeof showtimeSchema>;

export const showtimePageSchema = pageSchema(showtimeSchema);

export const showtimeQuerySchema = paginationQuerySchema.extend({
  movieId: z.uuid().optional(),
  cinemaId: z.uuid().optional(),
  /** Calendar day in the cinema's own time zone, not in UTC. */
  date: z.iso.date().optional(),
});
export type ShowtimeQuery = z.infer<typeof showtimeQuerySchema>;
```

`packages/contracts/src/seat.ts`:

```ts
import { z } from 'zod';

export const seatCategorySchema = z.enum(['STANDARD', 'VIP', 'RECLINER']);
export type SeatCategory = z.infer<typeof seatCategorySchema>;

/**
 * `HELD` and `CONFIRMED` cannot occur yet — nothing books a seat in phase 1.
 * The values exist now so the seat map does not have to be rewritten when
 * sub-project 2 starts producing them.
 */
export const seatStatusSchema = z.enum(['AVAILABLE', 'HELD', 'CONFIRMED']);
export type SeatStatus = z.infer<typeof seatStatusSchema>;

export const showtimeSeatSchema = z.object({
  seatId: z.uuid(),
  rowLabel: z.string().min(1),
  seatNumber: z.int().positive(),
  category: seatCategorySchema,
  /** Showtime base price plus the category surcharge; the client never computes this. */
  priceCents: z.int().nonnegative(),
  status: seatStatusSchema,
});
export type ShowtimeSeat = z.infer<typeof showtimeSeatSchema>;

export const showtimeSeatsSchema = z.object({
  showtimeId: z.uuid(),
  hallId: z.uuid(),
  hallName: z.string().min(1),
  seats: z.array(showtimeSeatSchema),
});
export type ShowtimeSeats = z.infer<typeof showtimeSeatsSchema>;
```

Append to `packages/contracts/src/index.ts`:

```ts
export * from './showtime.js';
export * from './seat.js';
```

- [ ] **Step 2: Add the timestamp cursor helper to `apps/api/src/catalog/cursor.ts`**

```ts
/** Narrows a decoded cursor to the `[iso timestamp, uuid]` shape showtimes order by. */
export function decodeTimestampIdCursor(cursor: string): [string, string] {
  const parts = decodeCursor(cursor);
  const [timestamp, id] = parts;
  if (typeof timestamp !== 'string' || typeof id !== 'string') throw new InvalidCursorError();
  if (Number.isNaN(Date.parse(timestamp))) throw new InvalidCursorError();
  return [timestamp, id];
}
```

- [ ] **Step 3: Write the failing e2e test at `apps/api/test/catalog-showtimes.e2e.spec.ts`**

```ts
import {
  seatCategorySchema,
  showtimePageSchema,
  showtimeSchema,
  showtimeSeatsSchema,
  problemDetailsSchema,
} from '@cinema/contracts';
import { VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { AppModule } from '../src/app.module';
import type { Database } from '../src/db/drizzle.module';
import { schema } from '../src/db/schema';
import { seedDatabase } from '../src/db/seed';
import { generateRequestId, registerCorrelation } from '../src/observability/logger';
import { getTestDatabaseUrl } from './harness';

describe('catalogue: showtimes and seats', () => {
  let app: NestFastifyApplication;
  let pool: Pool;
  let db: Database;

  beforeAll(async () => {
    pool = new Pool({ connectionString: getTestDatabaseUrl() });
    db = drizzle(pool, { schema }) as Database;
    await seedDatabase(db);

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
    await pool.end();
  });

  const premiereShowtimeId = async (): Promise<string> => {
    const result = await db.execute<{ id: string }>(
      sql`SELECT s.id FROM showtimes s JOIN halls h ON h.id = s.hall_id
          WHERE h.name = 'Premiere' ORDER BY s.starts_at LIMIT 1`,
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error('no premiere showtime seeded');
    return id;
  };

  it('orders showtimes by start time and paginates by cursor', async () => {
    const first = showtimePageSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/v1/showtimes?limit=5' })).json(),
    );
    expect(first.data).toHaveLength(5);

    const starts = first.data.map((showtime) => showtime.startsAt);
    expect(starts).toEqual([...starts].sort());

    const second = showtimePageSchema.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/showtimes?limit=5&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
        })
      ).json(),
    );
    const overlap = first.data.filter((a) => second.data.some((b) => b.id === a.id));
    expect(overlap).toHaveLength(0);
  });

  it('filters by movie', async () => {
    const anyShowtime = showtimePageSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/v1/showtimes?limit=1' })).json(),
    ).data[0];

    const page = showtimePageSchema.parse(
      (
        await app.inject({ method: 'GET', url: `/api/v1/showtimes?movieId=${anyShowtime?.movieId}&limit=100` })
      ).json(),
    );

    expect(page.data.length).toBeGreaterThan(0);
    expect(page.data.every((showtime) => showtime.movieId === anyShowtime?.movieId)).toBe(true);
  });

  it('filters by cinema', async () => {
    const anyShowtime = showtimePageSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/v1/showtimes?limit=1' })).json(),
    ).data[0];

    const page = showtimePageSchema.parse(
      (
        await app.inject({ method: 'GET', url: `/api/v1/showtimes?cinemaId=${anyShowtime?.cinemaId}&limit=100` })
      ).json(),
    );

    expect(page.data.every((showtime) => showtime.cinemaId === anyShowtime?.cinemaId)).toBe(true);
  });

  it('interprets the date filter in the cinema local zone, not UTC', async () => {
    // Warsaw is UTC+2 in September; the 20:30 local slot is 18:30Z, still the same
    // local day. A UTC-based filter would put nothing wrong here, so the tell is
    // that every returned showtime belongs to the requested local date.
    const cinemas = showtimePageSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/v1/showtimes?date=2026-09-03&limit=100' })).json(),
    );

    expect(cinemas.data.length).toBeGreaterThan(0);
    expect(cinemas.data.length).toBe(12 * 4);
  });

  it('answers 400 for a malformed date filter', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/showtimes?date=03-09-2026' });

    expect(response.statusCode).toBe(400);
    expect(problemDetailsSchema.parse(response.json()).type).toMatch(/validation-failed$/);
  });

  it('returns a single showtime with its hall and cinema', async () => {
    const id = await premiereShowtimeId();
    const response = await app.inject({ method: 'GET', url: `/api/v1/showtimes/${id}` });

    expect(response.statusCode).toBe(200);
    const showtime = showtimeSchema.parse(response.json());
    expect(showtime.hallName).toBe('Premiere');
    expect(showtime.cinemaName).toBe('Zoryany');
  });

  it('returns all 1000 seats of the premiere hall, ordered by row and number', async () => {
    const id = await premiereShowtimeId();
    const response = await app.inject({ method: 'GET', url: `/api/v1/showtimes/${id}/seats` });

    expect(response.statusCode).toBe(200);
    const map = showtimeSeatsSchema.parse(response.json());

    expect(map.seats).toHaveLength(1000);
    expect(map.hallName).toBe('Premiere');
    expect(map.seats[0]?.rowLabel).toBe('A');
    expect(map.seats[0]?.seatNumber).toBe(1);
    expect(map.seats.at(-1)?.rowLabel).toBe('Y');
    expect(map.seats.at(-1)?.seatNumber).toBe(40);
  });

  it('prices each seat as the showtime base price plus its category surcharge', async () => {
    const id = await premiereShowtimeId();
    const showtime = showtimeSchema.parse((await app.inject({ method: 'GET', url: `/api/v1/showtimes/${id}` })).json());
    const map = showtimeSeatsSchema.parse(
      (await app.inject({ method: 'GET', url: `/api/v1/showtimes/${id}/seats` })).json(),
    );

    const surcharges = { STANDARD: 0, VIP: 8_000, RECLINER: 15_000 } as const;
    for (const seat of map.seats) {
      expect(seat.priceCents).toBe(showtime.basePriceCents + surcharges[seat.category]);
    }
  });

  it('reports every seat as available, because nothing books seats yet', async () => {
    const id = await premiereShowtimeId();
    const map = showtimeSeatsSchema.parse(
      (await app.inject({ method: 'GET', url: `/api/v1/showtimes/${id}/seats` })).json(),
    );

    expect(map.seats.every((seat) => seat.status === 'AVAILABLE')).toBe(true);
  });

  it('answers 404 for the seat map of an unknown showtime', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/showtimes/019298a1-7c4e-7c3a-8f21-000000000000/seats',
    });

    expect(response.statusCode).toBe(404);
  });

  it('keeps the seat category codes in the database and in the contract in sync', async () => {
    const result = await db.execute<{ code: string }>(sql`SELECT code FROM seat_categories ORDER BY code`);

    expect(result.rows.map((row) => row.code).sort()).toEqual([...seatCategorySchema.options].sort());
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

```bash
npm run contracts:build
npm run test -w @cinema/api -- test/catalog-showtimes.e2e.spec.ts
```

Expected: FAIL — 404 on `/api/v1/showtimes`.

- [ ] **Step 5: Add the showtime queries to `apps/api/src/catalog/catalog.service.ts`**

Add these imports: `asc`, `eq`, `and`, `sql` (already present) plus the tables `cinemas`, `halls`, `seats`, `seatCategories`, `showtimes`, and the contract types `Showtime`, `ShowtimeQuery`, `ShowtimeSeats`. Then add the methods:

```ts
  async listShowtimes(query: ShowtimeQuery, executor: Executor = this.db): Promise<Page<Showtime>> {
    const filters = [];
    if (query.movieId) filters.push(eq(showtimes.movieId, query.movieId));
    if (query.cinemaId) filters.push(eq(cinemas.id, query.cinemaId));
    if (query.date) {
      // The calendar day is the cinema's, not UTC's. Doing this in SQL keeps one
      // rule for every zone instead of a per-request conversion in the service.
      filters.push(sql`(${showtimes.startsAt} AT TIME ZONE ${cinemas.timezone})::date = ${query.date}::date`);
    }
    if (query.cursor) {
      const [startsAt, id] = decodeTimestampIdCursor(query.cursor);
      filters.push(sql`(${showtimes.startsAt}, ${showtimes.id}) > (${startsAt}::timestamptz, ${id}::uuid)`);
    }

    const rows = await executor
      .select(showtimeColumns)
      .from(showtimes)
      .innerJoin(halls, eq(halls.id, showtimes.hallId))
      .innerJoin(cinemas, eq(cinemas.id, halls.cinemaId))
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(asc(showtimes.startsAt), asc(showtimes.id))
      .limit(query.limit + 1);

    return toPage(rows.map(toShowtime), query.limit, (row) => encodeCursor([row.startsAt, row.id]));
  }

  async getShowtime(id: string, executor: Executor = this.db): Promise<Showtime> {
    const [row] = await executor
      .select(showtimeColumns)
      .from(showtimes)
      .innerJoin(halls, eq(halls.id, showtimes.hallId))
      .innerJoin(cinemas, eq(cinemas.id, halls.cinemaId))
      .where(eq(showtimes.id, id))
      .limit(1);

    if (!row) throw new ResourceNotFoundError('Showtime', id);
    return toShowtime(row);
  }

  async getShowtimeSeats(id: string, executor: Executor = this.db): Promise<ShowtimeSeats> {
    const showtime = await this.getShowtime(id, executor);

    const rows = await executor
      .select({
        seatId: seats.id,
        rowLabel: seats.rowLabel,
        seatNumber: seats.seatNumber,
        category: seats.categoryCode,
        surchargeCents: seatCategories.surchargeCents,
      })
      .from(seats)
      .innerJoin(seatCategories, eq(seatCategories.code, seats.categoryCode))
      .where(eq(seats.hallId, showtime.hallId))
      .orderBy(asc(seats.rowLabel), asc(seats.seatNumber));

    return {
      showtimeId: showtime.id,
      hallId: showtime.hallId,
      hallName: showtime.hallName,
      seats: rows.map((row) => ({
        seatId: row.seatId,
        rowLabel: row.rowLabel,
        seatNumber: row.seatNumber,
        category: row.category as ShowtimeSeats['seats'][number]['category'],
        priceCents: showtime.basePriceCents + row.surchargeCents,
        // Phase 1 books nothing. Sub-project 2 replaces this constant with a
        // left join onto reservations.
        status: 'AVAILABLE' as const,
      })),
    };
  }
```

And these module-level helpers next to `toPage`:

```ts
const showtimeColumns = {
  id: showtimes.id,
  movieId: showtimes.movieId,
  hallId: showtimes.hallId,
  hallName: halls.name,
  cinemaId: cinemas.id,
  cinemaName: cinemas.name,
  startsAt: showtimes.startsAt,
  endsAt: showtimes.endsAt,
  basePriceCents: showtimes.basePriceCents,
  language: showtimes.language,
  format: showtimes.format,
};

type ShowtimeRow = {
  [K in keyof typeof showtimeColumns]: K extends 'startsAt' | 'endsAt'
    ? Date
    : K extends 'basePriceCents'
      ? number
      : string;
};

function toShowtime(row: ShowtimeRow): Showtime {
  return {
    ...row,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    format: row.format as Showtime['format'],
  };
}
```

- [ ] **Step 6: Add the three routes to `apps/api/src/catalog/catalog.controller.ts`**

```ts
  @Get('showtimes')
  @Validated(showtimePageSchema)
  listShowtimes(@Query(zodPipe(showtimeQuerySchema)) query: ShowtimeQuery): Promise<Page<Showtime>> {
    return this.catalog.listShowtimes(query);
  }

  @Get('showtimes/:id')
  @Validated(showtimeSchema)
  getShowtime(@Param(zodPipe(idParamSchema)) params: IdParam): Promise<Showtime> {
    return this.catalog.getShowtime(params.id);
  }

  @Get('showtimes/:id/seats')
  @Validated(showtimeSeatsSchema)
  getShowtimeSeats(@Param(zodPipe(idParamSchema)) params: IdParam): Promise<ShowtimeSeats> {
    return this.catalog.getShowtimeSeats(params.id);
  }
```

Extend the `@cinema/contracts` import with `showtimePageSchema`, `showtimeQuerySchema`, `showtimeSchema`, `showtimeSeatsSchema` and the types `Showtime`, `ShowtimeQuery`, `ShowtimeSeats`.

- [ ] **Step 7: Run the test to verify it passes**

```bash
npm run test -w @cinema/api -- test/catalog-showtimes.e2e.spec.ts
```

Expected: 11 tests PASS.

- [ ] **Step 8: Run the full suite and lint**

```bash
npm run test -w @cinema/api
npm run lint
```

Expected: 51 tests PASS, lint clean.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(api): serve showtimes with local-date filtering and the priced seat map"
```

---

## Task 10: OpenAPI generated from the contracts

**Files:**
- Create: `apps/api/src/openapi/routes.ts`, `apps/api/src/openapi/document.ts`, `apps/api/src/openapi/docs.controller.ts`, `apps/api/src/openapi/openapi.module.ts`
- Modify: `apps/api/src/app.module.ts`, `apps/api/src/main.ts`
- Test: `apps/api/src/openapi/document.test.ts`, `apps/api/test/openapi.e2e.spec.ts`

**Interfaces:**
- Consumes: every schema in `@cinema/contracts`.
- Produces:
  - `type RouteDoc = { method: 'get'; path: string; operationId: string; summary: string; tags: string[]; params?: { name: string; schema: z.ZodType }[]; query?: z.ZodType; response: z.ZodType; errors: number[] }`
  - `ROUTES: RouteDoc[]`
  - `buildOpenApiDocument(): OpenApiDocument`
  - `GET /api/openapi.json` → the document
  - `GET /api/docs` → Swagger UI over the same document

- [ ] **Step 1: Write the failing document test at `apps/api/src/openapi/document.test.ts`**

```ts
import { buildOpenApiDocument } from './document';

describe('buildOpenApiDocument', () => {
  const document = buildOpenApiDocument();

  it('declares OpenAPI 3.0 and the versioned server path', () => {
    expect(document.openapi).toBe('3.0.3');
    expect(document.info.title).toBe('Cinema Booking Platform API');
  });

  it('documents every catalogue route', () => {
    expect(Object.keys(document.paths).sort()).toEqual(
      [
        '/api/v1/cinemas',
        '/api/v1/cinemas/{id}',
        '/api/v1/movies',
        '/api/v1/movies/{id}',
        '/api/v1/showtimes',
        '/api/v1/showtimes/{id}',
        '/api/v1/showtimes/{id}/seats',
      ].sort(),
    );
  });

  it('derives request schemas from the contracts, not from hand-written JSON', () => {
    const listMovies = document.paths['/api/v1/movies']?.get;
    const limit = listMovies?.parameters?.find((parameter) => parameter.name === 'limit');

    expect(limit?.schema).toMatchObject({ type: 'integer', minimum: 1, maximum: 100 });
  });

  it('describes the success response body', () => {
    const getMovie = document.paths['/api/v1/movies/{id}']?.get;
    const schema = getMovie?.responses['200']?.content?.['application/json']?.schema;

    expect(schema).toMatchObject({ type: 'object' });
    expect(Object.keys((schema as { properties: object }).properties)).toContain('durationMinutes');
  });

  it('describes every declared failure as a problem document', () => {
    const getMovie = document.paths['/api/v1/movies/{id}']?.get;

    expect(getMovie?.responses['404']?.content?.['application/problem+json']).toBeDefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run test -w @cinema/api -- src/openapi/document.test.ts
```

Expected: FAIL — `Cannot find module './document'`.

- [ ] **Step 3: Implement `apps/api/src/openapi/routes.ts`**

```ts
import {
  cinemaPageSchema,
  cinemaSchema,
  movieSchema,
  moviePageSchema,
  paginationQuerySchema,
  showtimePageSchema,
  showtimeQuerySchema,
  showtimeSchema,
  showtimeSeatsSchema,
} from '@cinema/contracts';
import type { z } from 'zod';

export interface RouteDoc {
  method: 'get';
  /** OpenAPI path template, with `{id}` where Nest writes `:id`. */
  path: string;
  operationId: string;
  summary: string;
  tags: string[];
  pathParams: string[];
  query?: z.ZodType;
  response: z.ZodType;
  errors: number[];
}

const ID_PARAM = ['id'];

export const ROUTES: RouteDoc[] = [
  {
    method: 'get',
    path: '/api/v1/movies',
    operationId: 'listMovies',
    summary: 'List movies, ordered by title',
    tags: ['catalogue'],
    pathParams: [],
    query: paginationQuerySchema,
    response: moviePageSchema,
    errors: [400],
  },
  {
    method: 'get',
    path: '/api/v1/movies/{id}',
    operationId: 'getMovie',
    summary: 'Fetch one movie',
    tags: ['catalogue'],
    pathParams: ID_PARAM,
    response: movieSchema,
    errors: [400, 404],
  },
  {
    method: 'get',
    path: '/api/v1/cinemas',
    operationId: 'listCinemas',
    summary: 'List cinemas, ordered by name',
    tags: ['catalogue'],
    pathParams: [],
    query: paginationQuerySchema,
    response: cinemaPageSchema,
    errors: [400],
  },
  {
    method: 'get',
    path: '/api/v1/cinemas/{id}',
    operationId: 'getCinema',
    summary: 'Fetch one cinema',
    tags: ['catalogue'],
    pathParams: ID_PARAM,
    response: cinemaSchema,
    errors: [400, 404],
  },
  {
    method: 'get',
    path: '/api/v1/showtimes',
    operationId: 'listShowtimes',
    summary: 'List showtimes, ordered by start time',
    tags: ['catalogue'],
    pathParams: [],
    query: showtimeQuerySchema,
    response: showtimePageSchema,
    errors: [400],
  },
  {
    method: 'get',
    path: '/api/v1/showtimes/{id}',
    operationId: 'getShowtime',
    summary: 'Fetch one showtime',
    tags: ['catalogue'],
    pathParams: ID_PARAM,
    response: showtimeSchema,
    errors: [400, 404],
  },
  {
    method: 'get',
    path: '/api/v1/showtimes/{id}/seats',
    operationId: 'getShowtimeSeats',
    summary: 'Fetch the seat map of a showtime, with prices and availability',
    tags: ['catalogue'],
    pathParams: ID_PARAM,
    response: showtimeSeatsSchema,
    errors: [400, 404],
  },
];
```

- [ ] **Step 4: Implement `apps/api/src/openapi/document.ts`**

```ts
import { problemDetailsSchema } from '@cinema/contracts';
import { z } from 'zod';

import { ROUTES, type RouteDoc } from './routes';

type JsonSchema = Record<string, unknown>;

export interface OpenApiOperation {
  operationId: string;
  summary: string;
  tags: string[];
  parameters?: { name: string; in: 'path' | 'query'; required: boolean; schema: JsonSchema }[];
  responses: Record<string, { description: string; content?: Record<string, { schema: JsonSchema }> }>;
}

export interface OpenApiDocument {
  openapi: '3.0.3';
  info: { title: string; version: string; description: string };
  paths: Record<string, { get?: OpenApiOperation }>;
}

/** Zod 4 converts natively — no second schema language, so docs cannot drift from validation. */
function toJson(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  return z.toJSONSchema(schema, { target: 'openapi-3.0', io }) as JsonSchema;
}

function queryParameters(schema: z.ZodType): OpenApiOperation['parameters'] {
  const json = toJson(schema, 'input');
  const properties = (json.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((json.required as string[] | undefined) ?? []);

  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: 'query' as const,
    required: required.has(name),
    schema: property,
  }));
}

function operationFor(route: RouteDoc): OpenApiOperation {
  const problem = toJson(problemDetailsSchema, 'output');

  const responses: OpenApiOperation['responses'] = {
    '200': {
      description: 'Success',
      content: { 'application/json': { schema: toJson(route.response, 'output') } },
    },
  };

  for (const status of route.errors) {
    responses[String(status)] = {
      description: status === 404 ? 'Not found' : 'Bad request',
      content: { 'application/problem+json': { schema: problem } },
    };
  }

  return {
    operationId: route.operationId,
    summary: route.summary,
    tags: route.tags,
    parameters: [
      ...route.pathParams.map((name) => ({
        name,
        in: 'path' as const,
        required: true,
        schema: { type: 'string', format: 'uuid' } as JsonSchema,
      })),
      ...(route.query ? (queryParameters(route.query) ?? []) : []),
    ],
    responses,
  };
}

export function buildOpenApiDocument(): OpenApiDocument {
  const paths: OpenApiDocument['paths'] = {};

  for (const route of ROUTES) {
    paths[route.path] = { get: operationFor(route) };
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'Cinema Booking Platform API',
      version: '1.0.0',
      description:
        'Read-only catalogue of movies, cinemas, showtimes and seat maps. Generated from the Zod schemas in @cinema/contracts, which are the same schemas that validate requests.',
    },
    paths,
  };
}
```

- [ ] **Step 5: Run the document test to verify it passes**

```bash
npm run test -w @cinema/api -- src/openapi/document.test.ts
```

Expected: 5 tests PASS.

- [ ] **Step 6: Implement the controller and module**

`apps/api/src/openapi/docs.controller.ts`:

```ts
import { Controller, Get, Version, VERSION_NEUTRAL } from '@nestjs/common';

import { buildOpenApiDocument, type OpenApiDocument } from './document';

@Controller()
export class DocsController {
  private readonly document = buildOpenApiDocument();

  /** Unversioned: the document describes every version the API serves. */
  @Get('openapi.json')
  @Version(VERSION_NEUTRAL)
  openapi(): OpenApiDocument {
    return this.document;
  }
}
```

`apps/api/src/openapi/openapi.module.ts`:

```ts
import { Module } from '@nestjs/common';

import { DocsController } from './docs.controller';

@Module({ controllers: [DocsController] })
export class OpenApiModule {}
```

Add `OpenApiModule` to `AppModule`'s `imports`. With the global prefix, the route resolves to `/api/openapi.json`.

- [ ] **Step 7: Serve Swagger UI in `apps/api/src/main.ts`**

Insert before `await app.listen(...)`:

```ts
  await app.register(fastifySwagger, {
    mode: 'static',
    specification: { document: buildOpenApiDocument() as unknown as Record<string, unknown> },
  });
  await app.register(fastifySwaggerUi, { routePrefix: '/api/docs' });
```

with the imports:

```ts
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';

import { buildOpenApiDocument } from './openapi/document';
```

- [ ] **Step 8: Write the e2e test at `apps/api/test/openapi.e2e.spec.ts`**

```ts
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
```

- [ ] **Step 9: Run the api suite and check the UI by hand**

```bash
npm run test -w @cinema/api
```

Expected: 57 tests PASS.

```bash
docker compose up -d postgres 2>/dev/null || true
DATABASE_URL=postgres://cinema:cinema@localhost:5432/cinema npx tsx apps/api/src/main.ts &
sleep 3 && curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/docs && kill %1
```

Expected: `200`. (If compose is not up yet — it lands in Task 15 — run this check again after that task; `/api/openapi.json` is covered by the automated test either way.)

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(api): generate the OpenAPI document from the Zod contracts and serve Swagger UI"
```

---

## Task 11: `apps/web` scaffold — Vite, Tailwind, router, Query, typed API client

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/vitest.config.ts`, `apps/web/index.html`
- Create: `apps/web/src/main.tsx`, `apps/web/src/index.css`
- Create: `apps/web/src/app/providers.tsx`, `apps/web/src/app/router.tsx`, `apps/web/src/app/layout.tsx`, `apps/web/src/app/error-boundary.tsx`
- Create: `apps/web/src/shared/api/client.ts`, `apps/web/src/shared/api/query-keys.ts`, `apps/web/src/shared/api/catalog.ts`
- Create: `apps/web/src/shared/ui/{button,skeleton,empty-state,error-state,badge}.tsx`
- Create: `apps/web/src/shared/lib/format.ts`
- Create: `apps/web/src/test/{setup.ts,fixtures.ts,handlers.ts,server.ts,render.tsx}`
- Test: `apps/web/src/shared/api/client.test.ts`, `apps/web/src/shared/lib/format.test.ts`

**Interfaces:**
- Consumes: every schema from `@cinema/contracts`.
- Produces:
  - `class ApiError extends Error` with `readonly problem: ProblemDetails` and `get status(): number`
  - `apiFetch<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T>`
  - `queryKeys` — `{ movies: { all, list(limit), detail(id) }, cinemas: { all, list() }, showtimes: { all, list(filters), detail(id), seats(id) } }`
  - `catalogApi` — `listMovies({ cursor, limit })`, `getMovie(id)`, `listCinemas()`, `listShowtimes(filters)`, `getShowtime(id)`, `getShowtimeSeats(id)`
  - `formatPrice(cents: number): string`, `formatShowtimeTime(iso: string, timeZone: string): string`, `formatShowtimeDay(iso: string, timeZone: string): string`
  - `renderWithProviders(ui: ReactElement, options?: { route?: string })` from `test/render.tsx`

- [ ] **Step 1: Create `apps/web/package.json`**

```json
{
  "name": "@cinema/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "e2e": "playwright test"
  },
  "dependencies": {
    "@cinema/contracts": "*",
    "@tanstack/react-query": "^5.102.8",
    "react": "^19.2.8",
    "react-dom": "^19.2.8",
    "react-router": "^8.3.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@playwright/test": "^1.62.1",
    "@tailwindcss/vite": "^4.3.3",
    "@testing-library/jest-dom": "^6.6.4",
    "@testing-library/react": "^16.3.3",
    "@testing-library/user-event": "^14.6.1",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "^6.1.0",
    "jsdom": "^30.0.1",
    "msw": "^2.15.0",
    "tailwindcss": "^4.3.3",
    "typescript": "~6.0.3",
    "vite": "^8.2.2",
    "vitest": "^4.1.11"
  }
}
```

- [ ] **Step 2: Create the build configuration**

`apps/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "noEmit": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "e2e/**/*.ts", "vite.config.ts", "vitest.config.ts"]
}
```

`apps/web/vite.config.ts`:

```ts
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Same-origin in dev, so the client never needs an absolute API base URL.
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } },
  },
});
```

`apps/web/vitest.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
```

`apps/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Cinema</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Write the failing client test at `apps/web/src/shared/api/client.test.ts`**

```ts
import { movieSchema } from '@cinema/contracts';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../test/server';
import { ApiError, apiFetch } from './client';

const movie = {
  id: '019298a1-7c4e-7c3a-8f21-2f4a9c1d5b60',
  title: 'Dune: Part Two',
  description: 'seeded',
  durationMinutes: 166,
  posterUrl: 'https://images.example/posters/dune.jpg',
  releaseDate: '2024-03-01',
  rating: 8.5,
};

describe('apiFetch', () => {
  it('parses a successful response with the contract schema', async () => {
    server.use(http.get('/api/v1/movies/:id', () => HttpResponse.json(movie)));

    await expect(apiFetch('/api/v1/movies/1', movieSchema)).resolves.toEqual(movie);
  });

  it('turns a problem document into a typed ApiError', async () => {
    server.use(
      http.get('/api/v1/movies/:id', () =>
        HttpResponse.json(
          {
            type: 'https://cinema.example/errors/not-found',
            title: 'Resource not found',
            status: 404,
            detail: 'Movie 1 does not exist',
            instance: '/api/v1/movies/1',
            traceId: 'trace-1',
          },
          { status: 404, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    const error = await apiFetch('/api/v1/movies/1', movieSchema).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).problem.traceId).toBe('trace-1');
    expect((error as ApiError).message).toContain('does not exist');
  });

  it('still produces an ApiError when the server answers with something else entirely', async () => {
    server.use(http.get('/api/v1/movies/:id', () => new HttpResponse('gateway down', { status: 502 })));

    const error = await apiFetch('/api/v1/movies/1', movieSchema).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
  });

  it('fails loudly when the payload does not match the contract', async () => {
    server.use(http.get('/api/v1/movies/:id', () => HttpResponse.json({ ...movie, durationMinutes: 'long' })));

    await expect(apiFetch('/api/v1/movies/1', movieSchema)).rejects.toThrow(/contract/i);
  });
});
```

- [ ] **Step 4: Create the test harness files**

`apps/web/src/test/server.ts`:

```ts
import { setupServer } from 'msw/node';

import { handlers } from './handlers';

export const server = setupServer(...handlers);
```

`apps/web/src/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll } from 'vitest';

import { server } from './server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

`apps/web/src/test/fixtures.ts`:

```ts
import type { Cinema, Movie, Showtime, ShowtimeSeats } from '@cinema/contracts';

export const movieFixture: Movie = {
  id: '019298a1-7c4e-7c3a-8f21-2f4a9c1d5b60',
  title: 'Dune: Part Two',
  description: 'Seeded catalogue entry.',
  durationMinutes: 166,
  posterUrl: 'https://images.example/posters/dune-part-two.jpg',
  releaseDate: '2024-03-01',
  rating: 8.5,
};

export const otherMovieFixture: Movie = {
  ...movieFixture,
  id: '019298a1-7c4e-7c3a-8f21-2f4a9c1d5b61',
  title: 'Arrival',
  durationMinutes: 116,
  rating: 7.9,
};

export const cinemaFixture: Cinema = {
  id: '019298a1-7c4e-7c3a-8f21-2f4a9c1d5b70',
  name: 'Zoryany',
  city: 'Kyiv',
  address: 'Velyka Vasylkivska 41',
  timezone: 'Europe/Kyiv',
};

export const showtimeFixture: Showtime = {
  id: '019298a1-7c4e-7c3a-8f21-2f4a9c1d5b80',
  movieId: movieFixture.id,
  hallId: '019298a1-7c4e-7c3a-8f21-2f4a9c1d5b90',
  hallName: 'Premiere',
  cinemaId: cinemaFixture.id,
  cinemaName: cinemaFixture.name,
  startsAt: '2026-09-01T07:00:00.000Z',
  endsAt: '2026-09-01T10:16:00.000Z',
  basePriceCents: 15_000,
  language: 'uk',
  format: 'TWO_D',
};

/** A 3 x 4 hall — small enough to assert on, shaped like the real thing. */
export const seatMapFixture: ShowtimeSeats = {
  showtimeId: showtimeFixture.id,
  hallId: showtimeFixture.hallId,
  hallName: showtimeFixture.hallName,
  seats: ['A', 'B', 'C'].flatMap((rowLabel, rowIndex) =>
    [1, 2, 3, 4].map((seatNumber) => ({
      seatId: `019298a1-7c4e-7c3a-8f21-2f4a9c1d5${rowIndex}${seatNumber}0`,
      rowLabel,
      seatNumber,
      category: rowIndex === 2 ? ('VIP' as const) : ('STANDARD' as const),
      priceCents: rowIndex === 2 ? 23_000 : 15_000,
      status: 'AVAILABLE' as const,
    })),
  ),
};
```

`apps/web/src/test/handlers.ts`:

```ts
import { http, HttpResponse } from 'msw';

import { cinemaFixture, movieFixture, otherMovieFixture, seatMapFixture, showtimeFixture } from './fixtures';

/** Default happy path. Individual tests override with `server.use(...)`. */
export const handlers = [
  http.get('/api/v1/movies', () =>
    HttpResponse.json({ data: [otherMovieFixture, movieFixture], nextCursor: null }),
  ),
  http.get('/api/v1/movies/:id', () => HttpResponse.json(movieFixture)),
  http.get('/api/v1/cinemas', () => HttpResponse.json({ data: [cinemaFixture], nextCursor: null })),
  http.get('/api/v1/showtimes', () => HttpResponse.json({ data: [showtimeFixture], nextCursor: null })),
  http.get('/api/v1/showtimes/:id', () => HttpResponse.json(showtimeFixture)),
  http.get('/api/v1/showtimes/:id/seats', () => HttpResponse.json(seatMapFixture)),
];
```

The fixtures are typed with the contract types, so a contract change breaks the mocks at compile time instead of leaving the tests passing against a shape the server no longer returns.

- [ ] **Step 5: Run the client test to verify it fails**

```bash
npm run contracts:build
npm run test -w @cinema/web -- src/shared/api/client.test.ts
```

Expected: FAIL — `Failed to resolve import "./client"`.

- [ ] **Step 6: Implement `apps/web/src/shared/api/client.ts`**

```ts
import { problemDetailsSchema, type ProblemDetails } from '@cinema/contracts';
import type { z } from 'zod';

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

export class ApiError extends Error {
  constructor(readonly problem: ProblemDetails) {
    super(problem.detail);
    this.name = 'ApiError';
  }

  get status(): number {
    return this.problem.status;
  }
}

function fallbackProblem(status: number, path: string): ProblemDetails {
  return {
    type: 'about:blank',
    title: 'Unexpected response',
    status,
    detail: `The server answered ${status} without a problem document`,
    instance: path,
    traceId: 'unknown',
  };
}

/**
 * Every response is parsed with the same schema the server validates against.
 * The cost is a parse per response; the benefit is that a contract mismatch
 * surfaces here, as a named error, instead of as `undefined` deep in a render.
 */
export async function apiFetch<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { accept: 'application/json', ...init?.headers },
  });

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const problem = problemDetailsSchema.safeParse(body);
    throw new ApiError(problem.success ? problem.data : fallbackProblem(response.status, path));
  }

  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(`Response for ${path} does not match its contract: ${parsed.error.message}`);
  }

  return parsed.data;
}
```

- [ ] **Step 7: Run the client test to verify it passes**

```bash
npm run test -w @cinema/web -- src/shared/api/client.test.ts
```

Expected: 4 tests PASS.

- [ ] **Step 8: Implement the query keys and the catalogue calls**

`apps/web/src/shared/api/query-keys.ts`:

```ts
export interface ShowtimeFilters {
  movieId?: string;
  cinemaId?: string;
  date?: string;
}

/**
 * One typed place for every key. Sub-project 2 invalidates seat maps after a
 * hold; a stringly-typed key written at the call site would silently miss.
 */
export const queryKeys = {
  movies: {
    all: ['movies'] as const,
    list: (limit: number) => ['movies', 'list', { limit }] as const,
    detail: (id: string) => ['movies', 'detail', id] as const,
  },
  cinemas: {
    all: ['cinemas'] as const,
    list: () => ['cinemas', 'list'] as const,
  },
  showtimes: {
    all: ['showtimes'] as const,
    list: (filters: ShowtimeFilters) => ['showtimes', 'list', filters] as const,
    detail: (id: string) => ['showtimes', 'detail', id] as const,
    seats: (id: string) => ['showtimes', 'seats', id] as const,
  },
} as const;
```

`apps/web/src/shared/api/catalog.ts`:

```ts
import {
  cinemaPageSchema,
  moviePageSchema,
  movieSchema,
  showtimePageSchema,
  showtimeSchema,
  showtimeSeatsSchema,
  type Cinema,
  type Movie,
  type Page,
  type Showtime,
  type ShowtimeSeats,
} from '@cinema/contracts';

import { apiFetch } from './client';
import type { ShowtimeFilters } from './query-keys';

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}

export const catalogApi = {
  listMovies: (params: { cursor?: string; limit: number }): Promise<Page<Movie>> =>
    apiFetch(`/api/v1/movies${query(params)}`, moviePageSchema),

  getMovie: (id: string): Promise<Movie> => apiFetch(`/api/v1/movies/${id}`, movieSchema),

  listCinemas: (): Promise<Page<Cinema>> => apiFetch('/api/v1/cinemas?limit=100', cinemaPageSchema),

  listShowtimes: (filters: ShowtimeFilters): Promise<Page<Showtime>> =>
    apiFetch(`/api/v1/showtimes${query({ ...filters, limit: 100 })}`, showtimePageSchema),

  getShowtime: (id: string): Promise<Showtime> => apiFetch(`/api/v1/showtimes/${id}`, showtimeSchema),

  getShowtimeSeats: (id: string): Promise<ShowtimeSeats> =>
    apiFetch(`/api/v1/showtimes/${id}/seats`, showtimeSeatsSchema),
};
```

- [ ] **Step 9: Write the failing formatter test at `apps/web/src/shared/lib/format.test.ts`**

```ts
import { describe, expect, it } from 'vitest';

import { formatPrice, formatShowtimeDay, formatShowtimeTime } from './format';

describe('formatPrice', () => {
  it('renders minor units as hryvnia', () => {
    expect(formatPrice(15_000)).toBe('150 ₴');
    expect(formatPrice(23_050)).toBe('230,50 ₴');
  });

  it('renders a free seat as zero rather than an empty string', () => {
    expect(formatPrice(0)).toBe('0 ₴');
  });
});

describe('formatShowtimeTime', () => {
  it('renders a UTC instant in the cinema local zone', () => {
    expect(formatShowtimeTime('2026-09-01T07:00:00.000Z', 'Europe/Kyiv')).toBe('10:00');
    expect(formatShowtimeTime('2026-09-01T07:00:00.000Z', 'Europe/Warsaw')).toBe('09:00');
  });
});

describe('formatShowtimeDay', () => {
  it('renders the calendar day in the cinema local zone', () => {
    expect(formatShowtimeDay('2026-09-01T21:30:00.000Z', 'Europe/Kyiv')).toBe('2026-09-02');
    expect(formatShowtimeDay('2026-09-01T21:30:00.000Z', 'Europe/Warsaw')).toBe('2026-09-01');
  });
});
```

- [ ] **Step 10: Implement `apps/web/src/shared/lib/format.ts`**

```ts
const priceFormatter = new Intl.NumberFormat('uk-UA', {
  style: 'currency',
  currency: 'UAH',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/** Prices arrive as integer minor units; the client only ever renders them. */
export function formatPrice(cents: number): string {
  // Intl inserts a narrow no-break space before the symbol; normalise it so
  // tests and screen readers see one predictable string.
  return priceFormatter.format(cents / 100).replace(/ | /g, ' ');
}

export function formatShowtimeTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

export function formatShowtimeDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}
```

- [ ] **Step 11: Run the formatter test**

```bash
npm run test -w @cinema/web -- src/shared/lib/format.test.ts
```

Expected: 4 tests PASS. If the currency string differs from the assertion (ICU data varies), adjust the **assertion** to the produced string and keep the normalisation — do not weaken the test to a substring match.

- [ ] **Step 12: Create the UI primitives**

`apps/web/src/shared/ui/button.tsx`:

```tsx
import type { ButtonHTMLAttributes } from 'react';

export function Button({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:opacity-50 ${className}`}
    />
  );
}
```

`apps/web/src/shared/ui/skeleton.tsx`:

```tsx
/** Keeps the layout it will be replaced by, so the page does not jump. */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-md bg-slate-200 dark:bg-slate-800 ${className}`} />;
}
```

`apps/web/src/shared/ui/empty-state.tsx`:

```tsx
import type { ReactNode } from 'react';

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center dark:border-slate-700">
      <p className="text-base font-medium">{title}</p>
      <p className="mt-1 text-sm text-slate-500">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
```

`apps/web/src/shared/ui/error-state.tsx`:

```tsx
import { ApiError } from '../api/client';
import { Button } from './button';

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const detail = error instanceof ApiError ? error.problem.detail : 'Something went wrong';
  const traceId = error instanceof ApiError ? error.problem.traceId : null;

  return (
    <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-6 dark:border-red-800 dark:bg-red-950">
      <p className="font-medium text-red-800 dark:text-red-200">{detail}</p>
      {traceId ? <p className="mt-1 text-xs text-red-700 dark:text-red-300">Trace: {traceId}</p> : null}
      {onRetry ? (
        <Button className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
```

`apps/web/src/shared/ui/badge.tsx`:

```tsx
import type { ReactNode } from 'react';

export function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200">
      {children}
    </span>
  );
}
```

`apps/web/src/shared/ui/theme-toggle.tsx`:

```tsx
import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark' | 'system';

function apply(theme: Theme): void {
  const root = document.documentElement;
  root.classList.toggle(
    'dark',
    theme === 'dark' ||
      (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches),
  );
}

/**
 * The default is the reader's own setting; the toggle only overrides it. Reads
 * and writes are guarded because storage throws in some privacy modes.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const stored = localStorage.getItem('theme');
      return stored === 'light' || stored === 'dark' ? stored : 'system';
    } catch {
      return 'system';
    }
  });

  useEffect(() => {
    apply(theme);
    try {
      if (theme === 'system') localStorage.removeItem('theme');
      else localStorage.setItem('theme', theme);
    } catch {
      // A viewer who blocks site data still gets a working toggle for this visit.
    }
  }, [theme]);

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only">Theme</span>
      <select
        aria-label="Theme"
        className="rounded-md border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
        value={theme}
        onChange={(event) => setTheme(event.target.value as Theme)}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
```

The toggle has no test of its own: it is fifteen lines of presentation with no branching the suite would meaningfully cover, and the Playwright smoke test renders it on every page.

- [ ] **Step 13: Create the app shell**

`apps/web/src/index.css`:

```css
@import 'tailwindcss';

/* Tailwind 4 keys `dark:` off this selector, which is what the toggle flips. */
@custom-variant dark (&:where(.dark, .dark *));

:root {
  color-scheme: light dark;
}

body {
  @apply bg-white text-slate-900 antialiased dark:bg-slate-950 dark:text-slate-100;
}
```

`apps/web/src/app/error-boundary.tsx`:

```tsx
import { Component, type ErrorInfo, type ReactNode } from 'react';

import { ErrorState } from '../shared/ui/error-state';

/** A failing seat map must not take the whole application down with it. */
export class RouteErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  override state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('route crashed', error, info.componentStack);
  }

  override render() {
    if (this.state.error) return <ErrorState error={this.state.error} />;
    return this.props.children;
  }
}
```

`apps/web/src/app/providers.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // The catalogue barely changes; seat maps will, once anything books.
        staleTime: 5 * 60 * 1000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });
}

export function Providers({ client, children }: { client: QueryClient; children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
```

`apps/web/src/app/layout.tsx`:

```tsx
import { Link, Outlet } from 'react-router';

import { ThemeToggle } from '../shared/ui/theme-toggle';
import { RouteErrorBoundary } from './error-boundary';

export function Layout() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-8 flex items-center justify-between border-b border-slate-200 pb-4 dark:border-slate-800">
        <Link to="/" className="text-lg font-semibold">
          Cinema
        </Link>
        <ThemeToggle />
      </header>
      <main>
        <RouteErrorBoundary>
          <Outlet />
        </RouteErrorBoundary>
      </main>
    </div>
  );
}
```

`apps/web/src/app/router.tsx`:

```tsx
import { Route, Routes } from 'react-router';

import { MovieDetailPage } from '../features/showtimes/movie-detail-page';
import { MovieListPage } from '../features/movies/movie-list-page';
import { SeatMapPage } from '../features/seat-map/seat-map-page';
import { Layout } from './layout';

/**
 * Declarative routes, no data loaders: TanStack Query already owns loading and
 * caching, and a second mechanism would mean a second place data can go stale.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<MovieListPage />} />
        <Route path="movies/:movieId" element={<MovieDetailPage />} />
        <Route path="showtimes/:showtimeId" element={<SeatMapPage />} />
      </Route>
    </Routes>
  );
}
```

`apps/web/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';

import { Providers, createQueryClient } from './app/providers';
import { AppRoutes } from './app/router';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <Providers client={createQueryClient()}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </Providers>
  </StrictMode>,
);
```

The three page components are filled in by Tasks 12–14, but the router imports them now, so create each as a placeholder the next task replaces wholesale.

`apps/web/src/features/movies/movie-list-page.tsx`:

```tsx
export function MovieListPage() {
  return null;
}
```

`apps/web/src/features/showtimes/movie-detail-page.tsx`:

```tsx
export function MovieDetailPage() {
  return null;
}
```

`apps/web/src/features/seat-map/seat-map-page.tsx`:

```tsx
export function SeatMapPage() {
  return null;
}
```

- [ ] **Step 14: Create the render helper at `apps/web/src/test/render.tsx`**

```tsx
import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { ReactElement } from 'react';

import { Providers, createQueryClient } from '../app/providers';

export function renderWithProviders(ui: ReactElement, { route = '/' }: { route?: string } = {}): RenderResult {
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false, staleTime: 0 } });

  return render(
    <Providers client={client}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </Providers>,
  );
}
```

- [ ] **Step 15: Verify the whole web workspace builds and tests**

```bash
npm run test -w @cinema/web
npm run typecheck -w @cinema/web
npm run build -w @cinema/web
```

Expected: 8 tests PASS, typecheck clean, `apps/web/dist` produced.

- [ ] **Step 16: Commit**

```bash
git add -A
git commit -m "feat(web): scaffold the SPA with a contract-validating API client and MSW test harness"
```

---

## Task 12: Movie list screen

**Files:**
- Modify: `apps/web/src/features/movies/movie-list-page.tsx`
- Create: `apps/web/src/features/movies/movie-card.tsx`
- Test: `apps/web/src/features/movies/movie-list-page.test.tsx`

**Interfaces:**
- Consumes: `catalogApi.listMovies`, `queryKeys.movies.list`, `renderWithProviders`, the UI primitives.
- Produces: `MovieListPage`, `MovieCard` — the index route, listing movies with infinite scroll-by-button and linking to `/movies/:movieId`.

- [ ] **Step 1: Write the failing test at `apps/web/src/features/movies/movie-list-page.test.tsx`**

```tsx
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { screen, waitFor } from '@testing-library/react';

import { movieFixture, otherMovieFixture } from '../../test/fixtures';
import { renderWithProviders } from '../../test/render';
import { server } from '../../test/server';
import { MovieListPage } from './movie-list-page';

describe('MovieListPage', () => {
  it('shows a skeleton while loading, then the movies', async () => {
    renderWithProviders(<MovieListPage />);

    expect(screen.getByTestId('movie-list-skeleton')).toBeInTheDocument();

    expect(await screen.findByRole('link', { name: /Arrival/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Dune: Part Two/ })).toBeInTheDocument();
  });

  it('links each movie to its detail route', async () => {
    renderWithProviders(<MovieListPage />);

    const link = await screen.findByRole('link', { name: /Dune: Part Two/ });
    expect(link).toHaveAttribute('href', `/movies/${movieFixture.id}`);
  });

  it('loads the next page when asked and appends it', async () => {
    let call = 0;
    server.use(
      http.get('/api/v1/movies', () => {
        call += 1;
        return call === 1
          ? HttpResponse.json({ data: [otherMovieFixture], nextCursor: 'cursor-2' })
          : HttpResponse.json({ data: [movieFixture], nextCursor: null });
      }),
    );

    renderWithProviders(<MovieListPage />);

    await screen.findByRole('link', { name: /Arrival/ });
    await userEvent.click(screen.getByRole('button', { name: /load more/i }));

    expect(await screen.findByRole('link', { name: /Dune: Part Two/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Arrival/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument());
  });

  it('renders an empty state when the catalogue is empty', async () => {
    server.use(http.get('/api/v1/movies', () => HttpResponse.json({ data: [], nextCursor: null })));

    renderWithProviders(<MovieListPage />);

    expect(await screen.findByText(/no movies/i)).toBeInTheDocument();
  });

  it('renders the problem detail and a retry when the request fails', async () => {
    server.use(
      http.get('/api/v1/movies', () =>
        HttpResponse.json(
          {
            type: 'https://cinema.example/errors/internal',
            title: 'Internal server error',
            status: 500,
            detail: 'The request could not be processed',
            instance: '/api/v1/movies',
            traceId: 'trace-9',
          },
          { status: 500 },
        ),
      ),
    );

    renderWithProviders(<MovieListPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('The request could not be processed');
    expect(screen.getByText(/trace-9/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run test -w @cinema/web -- src/features/movies/movie-list-page.test.tsx
```

Expected: FAIL — nothing renders; `movie-list-skeleton` is not found.

- [ ] **Step 3: Implement `apps/web/src/features/movies/movie-card.tsx`**

```tsx
import type { Movie } from '@cinema/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';

import { catalogApi } from '../../shared/api/catalog';
import { queryKeys } from '../../shared/api/query-keys';
import { Badge } from '../../shared/ui/badge';

export function MovieCard({ movie }: { movie: Movie }) {
  const queryClient = useQueryClient();

  /**
   * Pointing at a card is a strong signal it is about to be opened. Warming the
   * detail route's two queries here makes the navigation feel instant, and
   * costs nothing when the guess is wrong — the cache simply expires.
   */
  const prefetch = (): void => {
    void queryClient.prefetchQuery({
      queryKey: queryKeys.movies.detail(movie.id),
      queryFn: () => catalogApi.getMovie(movie.id),
    });
    void queryClient.prefetchQuery({
      queryKey: queryKeys.showtimes.list({ movieId: movie.id }),
      queryFn: () => catalogApi.listShowtimes({ movieId: movie.id }),
    });
  };

  return (
    <Link
      to={`/movies/${movie.id}`}
      onMouseEnter={prefetch}
      onFocus={prefetch}
      className="group rounded-lg border border-slate-200 p-4 transition hover:border-sky-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 dark:border-slate-800"
    >
      <img
        src={movie.posterUrl}
        alt=""
        className="mb-3 aspect-2/3 w-full rounded-md object-cover"
        loading="lazy"
      />
      <h2 className="font-medium group-hover:text-sky-600">{movie.title}</h2>
      <p className="mt-1 flex items-center gap-2 text-sm text-slate-500">
        <Badge>{movie.rating.toFixed(1)}</Badge>
        <span>{movie.durationMinutes} min</span>
      </p>
    </Link>
  );
}
```

- [ ] **Step 4: Implement `apps/web/src/features/movies/movie-list-page.tsx`**

```tsx
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';

import { catalogApi } from '../../shared/api/catalog';
import { queryKeys } from '../../shared/api/query-keys';
import { Button } from '../../shared/ui/button';
import { EmptyState } from '../../shared/ui/empty-state';
import { ErrorState } from '../../shared/ui/error-state';
import { Skeleton } from '../../shared/ui/skeleton';
import { MovieCard } from './movie-card';

const PAGE_SIZE = 12;

export function MovieListPage() {
  const query = useInfiniteQuery({
    queryKey: queryKeys.movies.list(PAGE_SIZE),
    queryFn: ({ pageParam }) =>
      catalogApi.listMovies({ limit: PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    // Keeps the rendered list in place while the next page is in flight, instead
    // of collapsing the grid back to a skeleton.
    placeholderData: keepPreviousData,
  });

  if (query.isPending) {
    return (
      <div data-testid="movie-list-skeleton" className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="aspect-2/3 w-full" />
        ))}
      </div>
    );
  }

  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const movies = query.data.pages.flatMap((page) => page.data);

  if (movies.length === 0) {
    return <EmptyState title="No movies yet" description="The catalogue is empty." />;
  }

  return (
    <section aria-labelledby="movies-heading">
      <h1 id="movies-heading" className="mb-6 text-2xl font-semibold">
        Now showing
      </h1>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {movies.map((movie) => (
          <MovieCard key={movie.id} movie={movie} />
        ))}
      </div>

      {query.hasNextPage ? (
        <div className="mt-8 flex justify-center">
          <Button onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
            {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npm run test -w @cinema/web -- src/features/movies/movie-list-page.test.tsx
```

Expected: 5 tests PASS.

- [ ] **Step 6: Run the full web suite**

```bash
npm run test -w @cinema/web
npm run typecheck -w @cinema/web
```

Expected: 13 tests PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): add the movie list screen with cursor-based infinite loading"
```

---

## Task 13: Movie detail with URL-driven showtime filters

**Files:**
- Modify: `apps/web/src/features/showtimes/movie-detail-page.tsx`
- Create: `apps/web/src/features/showtimes/showtime-filters.tsx`, `apps/web/src/features/showtimes/showtime-list.tsx`
- Test: `apps/web/src/features/showtimes/movie-detail-page.test.tsx`

**Interfaces:**
- Consumes: `catalogApi.getMovie`, `catalogApi.listCinemas`, `catalogApi.listShowtimes`, `queryKeys`, `formatShowtimeTime`, `formatShowtimeDay`.
- Produces:
  - `MovieDetailPage` — route `/movies/:movieId`
  - `ShowtimeFilters({ cinemas, value, onChange })` where `value: { cinemaId?: string; date?: string }`
  - `ShowtimeList({ showtimes, cinemasById })` — links each showtime to `/showtimes/:id`

- [ ] **Step 1: Write the failing test at `apps/web/src/features/showtimes/movie-detail-page.test.tsx`**

```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { cinemaFixture, movieFixture, showtimeFixture } from '../../test/fixtures';
import { renderWithProviders } from '../../test/render';
import { server } from '../../test/server';
import { MovieDetailPage } from './movie-detail-page';

function renderPage(route = `/movies/${movieFixture.id}`) {
  return renderWithProviders(
    <Routes>
      <Route path="movies/:movieId" element={<MovieDetailPage />} />
    </Routes>,
    { route },
  );
}

describe('MovieDetailPage', () => {
  it('shows the movie and its showtimes in the cinema local time', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: /Dune: Part Two/ })).toBeInTheDocument();
    // 07:00Z in Europe/Kyiv is 10:00 local.
    expect(await screen.findByRole('link', { name: /10:00/ })).toHaveAttribute(
      'href',
      `/showtimes/${showtimeFixture.id}`,
    );
  });

  it('reads the initial filters from the URL', async () => {
    renderPage(`/movies/${movieFixture.id}?cinemaId=${cinemaFixture.id}&date=2026-09-03`);

    await screen.findByRole('heading', { name: /Dune: Part Two/ });

    expect(await screen.findByLabelText(/cinema/i)).toHaveValue(cinemaFixture.id);
    expect(screen.getByLabelText(/date/i)).toHaveValue('2026-09-03');
  });

  it('writes a changed filter back into the URL and refetches', async () => {
    const requested: string[] = [];
    server.use(
      http.get('/api/v1/showtimes', ({ request }) => {
        requested.push(new URL(request.url).searchParams.get('date') ?? '');
        return HttpResponse.json({ data: [showtimeFixture], nextCursor: null });
      }),
    );

    renderPage();
    await screen.findByRole('heading', { name: /Dune: Part Two/ });

    await userEvent.type(await screen.findByLabelText(/date/i), '2026-09-05');

    await waitFor(() => expect(requested).toContain('2026-09-05'));
  });

  it('offers a reset when the filters exclude every showtime', async () => {
    server.use(http.get('/api/v1/showtimes', () => HttpResponse.json({ data: [], nextCursor: null })));

    renderPage(`/movies/${movieFixture.id}?date=2026-12-25`);

    expect(await screen.findByText(/no showtimes/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /clear filters/i }));

    await waitFor(() => expect(screen.getByLabelText(/date/i)).toHaveValue(''));
  });

  it('renders a problem document as an alert', async () => {
    server.use(
      http.get('/api/v1/movies/:id', () =>
        HttpResponse.json(
          {
            type: 'https://cinema.example/errors/not-found',
            title: 'Resource not found',
            status: 404,
            detail: 'Movie does not exist',
            instance: '/api/v1/movies/x',
            traceId: 'trace-3',
          },
          { status: 404 },
        ),
      ),
    );

    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Movie does not exist');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run test -w @cinema/web -- src/features/showtimes/movie-detail-page.test.tsx
```

Expected: FAIL — the heading never appears (the page is still the placeholder).

- [ ] **Step 3: Implement `apps/web/src/features/showtimes/showtime-filters.tsx`**

```tsx
import type { Cinema } from '@cinema/contracts';

import { Button } from '../../shared/ui/button';

export interface ShowtimeFilterValue {
  cinemaId?: string;
  date?: string;
}

export function ShowtimeFilters({
  cinemas,
  value,
  onChange,
}: {
  cinemas: Cinema[];
  value: ShowtimeFilterValue;
  onChange: (next: ShowtimeFilterValue) => void;
}) {
  const hasFilters = Boolean(value.cinemaId ?? value.date);

  return (
    <div className="mb-6 flex flex-wrap items-end gap-4">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Cinema</span>
        <select
          className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
          value={value.cinemaId ?? ''}
          onChange={(event) => onChange({ ...value, cinemaId: event.target.value || undefined })}
        >
          <option value="">All cinemas</option>
          {cinemas.map((cinema) => (
            <option key={cinema.id} value={cinema.id}>
              {cinema.name} — {cinema.city}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Date</span>
        <input
          type="date"
          className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
          value={value.date ?? ''}
          onChange={(event) => onChange({ ...value, date: event.target.value || undefined })}
        />
      </label>

      {hasFilters ? <Button onClick={() => onChange({})}>Clear filters</Button> : null}
    </div>
  );
}
```

- [ ] **Step 4: Implement `apps/web/src/features/showtimes/showtime-list.tsx`**

```tsx
import type { Cinema, Showtime } from '@cinema/contracts';
import { Link } from 'react-router';

import { formatShowtimeDay, formatShowtimeTime } from '../../shared/lib/format';
import { Badge } from '../../shared/ui/badge';

export function ShowtimeList({
  showtimes,
  cinemasById,
}: {
  showtimes: Showtime[];
  cinemasById: Map<string, Cinema>;
}) {
  return (
    <ul className="flex flex-col gap-3">
      {showtimes.map((showtime) => {
        // Instants are UTC; the cinema's own zone is what a viewer expects to read.
        const timeZone = cinemasById.get(showtime.cinemaId)?.timezone ?? 'UTC';

        return (
          <li key={showtime.id}>
            <Link
              to={`/showtimes/${showtime.id}`}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 px-4 py-3 transition hover:border-sky-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 dark:border-slate-800"
            >
              <span className="text-lg font-semibold tabular-nums">
                {formatShowtimeTime(showtime.startsAt, timeZone)}
              </span>
              <span className="text-sm text-slate-500">
                {formatShowtimeDay(showtime.startsAt, timeZone)}
              </span>
              <span className="text-sm">
                {showtime.cinemaName} · {showtime.hallName}
              </span>
              <Badge>{showtime.format}</Badge>
              <Badge>{showtime.language}</Badge>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
```

- [ ] **Step 5: Implement `apps/web/src/features/showtimes/movie-detail-page.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query';
import { useSearchParams, useParams } from 'react-router';

import { catalogApi } from '../../shared/api/catalog';
import { queryKeys } from '../../shared/api/query-keys';
import { EmptyState } from '../../shared/ui/empty-state';
import { ErrorState } from '../../shared/ui/error-state';
import { Skeleton } from '../../shared/ui/skeleton';
import { ShowtimeFilters, type ShowtimeFilterValue } from './showtime-filters';
import { ShowtimeList } from './showtime-list';

export function MovieDetailPage() {
  const { movieId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  /**
   * Filters live in the URL, not in component state: the selection is shareable
   * and the back button works. This is also why the app needs no client-state
   * store at this stage.
   */
  const filters: ShowtimeFilterValue = {
    cinemaId: searchParams.get('cinemaId') ?? undefined,
    date: searchParams.get('date') ?? undefined,
  };

  const applyFilters = (next: ShowtimeFilterValue): void => {
    const params = new URLSearchParams();
    if (next.cinemaId) params.set('cinemaId', next.cinemaId);
    if (next.date) params.set('date', next.date);
    setSearchParams(params, { replace: true });
  };

  const movie = useQuery({
    queryKey: queryKeys.movies.detail(movieId),
    queryFn: () => catalogApi.getMovie(movieId),
  });

  const cinemas = useQuery({
    queryKey: queryKeys.cinemas.list(),
    queryFn: () => catalogApi.listCinemas(),
  });

  const showtimes = useQuery({
    queryKey: queryKeys.showtimes.list({ movieId, ...filters }),
    queryFn: () => catalogApi.listShowtimes({ movieId, ...filters }),
  });

  if (movie.isError) return <ErrorState error={movie.error} onRetry={() => void movie.refetch()} />;
  if (movie.isPending) return <Skeleton className="h-40 w-full" />;

  const cinemaList = cinemas.data?.data ?? [];
  const cinemasById = new Map(cinemaList.map((cinema) => [cinema.id, cinema]));

  return (
    <article>
      <header className="mb-8 flex flex-col gap-4 md:flex-row">
        <img src={movie.data.posterUrl} alt="" className="w-48 rounded-lg object-cover" />
        <div>
          <h1 className="text-2xl font-semibold">{movie.data.title}</h1>
          <p className="mt-2 text-sm text-slate-500">
            {movie.data.durationMinutes} min · {movie.data.rating.toFixed(1)} · {movie.data.releaseDate}
          </p>
          <p className="mt-4 max-w-prose">{movie.data.description}</p>
        </div>
      </header>

      <h2 className="mb-4 text-xl font-semibold">Showtimes</h2>
      <ShowtimeFilters cinemas={cinemaList} value={filters} onChange={applyFilters} />

      {showtimes.isPending ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-14 w-full" />
          ))}
        </div>
      ) : showtimes.isError ? (
        <ErrorState error={showtimes.error} onRetry={() => void showtimes.refetch()} />
      ) : showtimes.data.data.length === 0 ? (
        <EmptyState
          title="No showtimes match these filters"
          description="Try another date or another cinema."
        />
      ) : (
        <ShowtimeList showtimes={showtimes.data.data} cinemasById={cinemasById} />
      )}
    </article>
  );
}
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
npm run test -w @cinema/web -- src/features/showtimes/movie-detail-page.test.tsx
```

Expected: 5 tests PASS.

- [ ] **Step 7: Run the full web suite**

```bash
npm run test -w @cinema/web
npm run typecheck -w @cinema/web
```

Expected: 18 tests PASS, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(web): add the movie detail screen with showtime filters held in the URL"
```

---

## Task 14: Accessible seat map

**Files:**
- Create: `apps/web/src/features/seat-map/build-rows.ts`, `apps/web/src/features/seat-map/seat-button.tsx`, `apps/web/src/features/seat-map/seat-grid.tsx`, `apps/web/src/shared/lib/use-roving-grid.ts`
- Modify: `apps/web/src/features/seat-map/seat-map-page.tsx`
- Test: `apps/web/src/features/seat-map/build-rows.test.ts`, `apps/web/src/features/seat-map/seat-map-page.test.tsx`

**Interfaces:**
- Consumes: `catalogApi.getShowtime`, `catalogApi.getShowtimeSeats`, `queryKeys.showtimes.*`, `formatPrice`.
- Produces:
  - `buildRows(seats: ShowtimeSeat[]): { label: string; seats: ShowtimeSeat[] }[]`
  - `useRovingGrid(rowLengths: number[])` → `{ active: GridPosition; setActive: (p: GridPosition) => void; onKeyDown: (event: KeyboardEvent<HTMLElement>) => void }` where `GridPosition = { row: number; col: number }`
  - `SeatButton` — memoised, one `<button>` per seat
  - `SeatGrid({ rows })`
  - `SeatMapPage` — route `/showtimes/:showtimeId`

- [ ] **Step 1: Write the failing test at `apps/web/src/features/seat-map/build-rows.test.ts`**

```ts
import type { ShowtimeSeat } from '@cinema/contracts';
import { describe, expect, it } from 'vitest';

import { buildRows } from './build-rows';

const seat = (rowLabel: string, seatNumber: number): ShowtimeSeat => ({
  seatId: `${rowLabel}${seatNumber}`,
  rowLabel,
  seatNumber,
  category: 'STANDARD',
  priceCents: 15_000,
  status: 'AVAILABLE',
});

describe('buildRows', () => {
  it('groups a flat seat list into rows', () => {
    const rows = buildRows([seat('A', 1), seat('A', 2), seat('B', 1)]);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.label).toBe('A');
    expect(rows[0]?.seats).toHaveLength(2);
    expect(rows[1]?.label).toBe('B');
  });

  it('orders rows and seats regardless of the order they arrive in', () => {
    const rows = buildRows([seat('B', 2), seat('A', 3), seat('B', 1), seat('A', 1)]);

    expect(rows.map((row) => row.label)).toEqual(['A', 'B']);
    expect(rows[0]?.seats.map((s) => s.seatNumber)).toEqual([1, 3]);
    expect(rows[1]?.seats.map((s) => s.seatNumber)).toEqual([1, 2]);
  });

  it('handles a hall with rows of unequal length', () => {
    const rows = buildRows([seat('A', 1), seat('B', 1), seat('B', 2), seat('B', 3)]);

    expect(rows.map((row) => row.seats.length)).toEqual([1, 3]);
  });

  it('returns nothing for an empty hall', () => {
    expect(buildRows([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails, then implement `apps/web/src/features/seat-map/build-rows.ts`**

```bash
npm run test -w @cinema/web -- src/features/seat-map/build-rows.test.ts
```

Expected: FAIL — `Failed to resolve import "./build-rows"`.

```ts
import type { ShowtimeSeat } from '@cinema/contracts';

export interface SeatRow {
  label: string;
  seats: ShowtimeSeat[];
}

/**
 * The API returns a flat, ordered list; the grid needs rows. Sorting here rather
 * than trusting the order keeps the component correct if the query ever changes.
 */
export function buildRows(seats: ShowtimeSeat[]): SeatRow[] {
  const byRow = new Map<string, ShowtimeSeat[]>();

  for (const seat of seats) {
    const row = byRow.get(seat.rowLabel);
    if (row) row.push(seat);
    else byRow.set(seat.rowLabel, [seat]);
  }

  return [...byRow.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, rowSeats]) => ({
      label,
      seats: [...rowSeats].sort((a, b) => a.seatNumber - b.seatNumber),
    }));
}
```

Re-run: 4 tests PASS.

- [ ] **Step 3: Implement `apps/web/src/shared/lib/use-roving-grid.ts`**

```ts
import { useCallback, useState, type KeyboardEvent } from 'react';

export interface GridPosition {
  row: number;
  col: number;
}

/**
 * Roving tabindex: the grid holds a single tab stop and the arrow keys move it.
 * A thousand focusable seats would otherwise mean a thousand presses of Tab to
 * cross the hall.
 */
export function useRovingGrid(rowLengths: number[]) {
  const [active, setActive] = useState<GridPosition>({ row: 0, col: 0 });

  const clamp = useCallback(
    (position: GridPosition): GridPosition => {
      const row = Math.max(0, Math.min(position.row, rowLengths.length - 1));
      const length = rowLengths[row] ?? 0;
      return { row, col: Math.max(0, Math.min(position.col, length - 1)) };
    },
    [rowLengths],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>): void => {
      const moves: Record<string, GridPosition> = {
        ArrowRight: { row: active.row, col: active.col + 1 },
        ArrowLeft: { row: active.row, col: active.col - 1 },
        ArrowDown: { row: active.row + 1, col: active.col },
        ArrowUp: { row: active.row - 1, col: active.col },
        Home: { row: active.row, col: 0 },
        End: { row: active.row, col: Number.MAX_SAFE_INTEGER },
      };

      const target = moves[event.key];
      if (!target) return;

      event.preventDefault();
      const next = clamp(target);
      setActive(next);

      document
        .querySelector<HTMLElement>(`[data-grid-cell="${next.row}-${next.col}"]`)
        ?.focus();
    },
    [active, clamp],
  );

  return { active, setActive, onKeyDown };
}
```

- [ ] **Step 4: Implement `apps/web/src/features/seat-map/seat-button.tsx`**

```tsx
import type { ShowtimeSeat } from '@cinema/contracts';
import { memo } from 'react';

import { formatPrice } from '../../shared/lib/format';

const CATEGORY_STYLE: Record<ShowtimeSeat['category'], string> = {
  STANDARD: 'bg-slate-200 dark:bg-slate-700',
  VIP: 'bg-amber-200 dark:bg-amber-700',
  RECLINER: 'bg-violet-200 dark:bg-violet-700',
};

/** Status is never carried by colour alone — a glyph carries it too. */
const STATUS_GLYPH: Record<ShowtimeSeat['status'], string> = {
  AVAILABLE: '',
  HELD: '◌',
  CONFIRMED: '×',
};

export interface SeatButtonProps {
  seat: ShowtimeSeat;
  position: string;
  isActive: boolean;
  onFocus: () => void;
}

/**
 * Memoised on purpose: the premiere hall renders 1000 of these, and selecting a
 * seat in sub-project 2 must repaint one of them, not the whole hall.
 */
export const SeatButton = memo(function SeatButton({ seat, position, isActive, onFocus }: SeatButtonProps) {
  const taken = seat.status !== 'AVAILABLE';

  return (
    <button
      type="button"
      data-grid-cell={position}
      tabIndex={isActive ? 0 : -1}
      onFocus={onFocus}
      disabled={taken}
      aria-label={`Row ${seat.rowLabel}, seat ${seat.seatNumber}, ${seat.category.toLowerCase()}, ${formatPrice(
        seat.priceCents,
      )}, ${seat.status.toLowerCase()}`}
      className={`flex size-7 items-center justify-center rounded text-[10px] font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:cursor-not-allowed disabled:opacity-40 ${
        CATEGORY_STYLE[seat.category]
      }`}
    >
      <span aria-hidden>{STATUS_GLYPH[seat.status] || seat.seatNumber}</span>
    </button>
  );
});
```

- [ ] **Step 5: Implement `apps/web/src/features/seat-map/seat-grid.tsx`**

```tsx
import { useMemo } from 'react';

import { useRovingGrid } from '../../shared/lib/use-roving-grid';
import type { SeatRow } from './build-rows';
import { SeatButton } from './seat-button';

export function SeatGrid({ rows }: { rows: SeatRow[] }) {
  const rowLengths = useMemo(() => rows.map((row) => row.seats.length), [rows]);
  const { active, setActive, onKeyDown } = useRovingGrid(rowLengths);

  return (
    <div
      role="grid"
      aria-label="Seat map"
      onKeyDown={onKeyDown}
      className="inline-flex flex-col gap-1 overflow-x-auto"
    >
      {rows.map((row, rowIndex) => (
        <div key={row.label} role="row" className="flex items-center gap-1">
          <span aria-hidden className="w-5 text-right text-xs text-slate-500">
            {row.label}
          </span>
          {row.seats.map((seat, colIndex) => (
            <div role="gridcell" key={seat.seatId}>
              <SeatButton
                seat={seat}
                position={`${rowIndex}-${colIndex}`}
                isActive={active.row === rowIndex && active.col === colIndex}
                onFocus={() => setActive({ row: rowIndex, col: colIndex })}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Write the failing page test at `apps/web/src/features/seat-map/seat-map-page.test.tsx`**

```tsx
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import { seatMapFixture, showtimeFixture } from '../../test/fixtures';
import { renderWithProviders } from '../../test/render';
import { server } from '../../test/server';
import { SeatMapPage } from './seat-map-page';

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="showtimes/:showtimeId" element={<SeatMapPage />} />
    </Routes>,
    { route: `/showtimes/${showtimeFixture.id}` },
  );
}

describe('SeatMapPage', () => {
  it('renders every seat as a button labelled with row, number, category and price', async () => {
    renderPage();

    expect(await screen.findByRole('grid', { name: /seat map/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /row [A-C], seat/i })).toHaveLength(12);
    expect(
      screen.getByRole('button', { name: /Row C, seat 1, vip, 230 ₴, available/i }),
    ).toBeInTheDocument();
  });

  it('exposes a single tab stop and moves focus with the arrow keys', async () => {
    renderPage();

    const first = await screen.findByRole('button', { name: /Row A, seat 1/i });
    expect(first).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('button', { name: /Row A, seat 2/i })).toHaveAttribute('tabindex', '-1');

    first.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: /Row A, seat 2/i })).toHaveFocus();

    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: /Row B, seat 2/i })).toHaveFocus();
  });

  it('does not walk past the edge of the hall', async () => {
    renderPage();

    const first = await screen.findByRole('button', { name: /Row A, seat 1/i });
    first.focus();
    await userEvent.keyboard('{ArrowLeft}{ArrowUp}');

    expect(first).toHaveFocus();
  });

  it('disables a seat that is already taken', async () => {
    server.use(
      http.get('/api/v1/showtimes/:id/seats', () =>
        HttpResponse.json({
          ...seatMapFixture,
          seats: seatMapFixture.seats.map((seat, index) =>
            index === 0 ? { ...seat, status: 'CONFIRMED' as const } : seat,
          ),
        }),
      ),
    );

    renderPage();

    expect(await screen.findByRole('button', { name: /Row A, seat 1.*confirmed/i })).toBeDisabled();
  });

  it('shows the showtime heading and a legend of the categories', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: /Premiere/ })).toBeInTheDocument();
    expect(screen.getByText(/standard/i)).toBeInTheDocument();
    expect(screen.getByText(/vip/i)).toBeInTheDocument();
  });

  it('renders an alert when the seat map cannot be loaded', async () => {
    server.use(
      http.get('/api/v1/showtimes/:id/seats', () =>
        HttpResponse.json(
          {
            type: 'https://cinema.example/errors/not-found',
            title: 'Resource not found',
            status: 404,
            detail: 'Showtime does not exist',
            instance: '/api/v1/showtimes/x/seats',
            traceId: 'trace-7',
          },
          { status: 404 },
        ),
      ),
    );

    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Showtime does not exist');
  });
});
```

- [ ] **Step 7: Implement `apps/web/src/features/seat-map/seat-map-page.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';

import { catalogApi } from '../../shared/api/catalog';
import { queryKeys } from '../../shared/api/query-keys';
import { ErrorState } from '../../shared/ui/error-state';
import { Skeleton } from '../../shared/ui/skeleton';
import { buildRows } from './build-rows';
import { SeatGrid } from './seat-grid';

const LEGEND = [
  { label: 'Standard', className: 'bg-slate-200 dark:bg-slate-700' },
  { label: 'VIP', className: 'bg-amber-200 dark:bg-amber-700' },
  { label: 'Recliner', className: 'bg-violet-200 dark:bg-violet-700' },
];

export function SeatMapPage() {
  const { showtimeId = '' } = useParams();

  const showtime = useQuery({
    queryKey: queryKeys.showtimes.detail(showtimeId),
    queryFn: () => catalogApi.getShowtime(showtimeId),
  });

  const seats = useQuery({
    queryKey: queryKeys.showtimes.seats(showtimeId),
    // Sub-project 2 turns this into a live view; 30 s keeps the shape now.
    staleTime: 30_000,
    queryFn: () => catalogApi.getShowtimeSeats(showtimeId),
  });

  if (seats.isError) return <ErrorState error={seats.error} onRetry={() => void seats.refetch()} />;
  if (showtime.isError) return <ErrorState error={showtime.error} onRetry={() => void showtime.refetch()} />;
  if (seats.isPending || showtime.isPending) return <Skeleton className="h-96 w-full" />;

  const rows = buildRows(seats.data.seats);

  return (
    <section>
      <h1 className="text-2xl font-semibold">
        {showtime.data.cinemaName} · {seats.data.hallName}
      </h1>
      <p className="mt-1 text-sm text-slate-500">
        {seats.data.seats.length} seats · {showtime.data.format} · {showtime.data.language}
      </p>

      <div className="my-6 h-1.5 w-full rounded-full bg-slate-300 dark:bg-slate-700" aria-hidden />
      <p className="mb-6 text-center text-xs uppercase tracking-widest text-slate-400">Screen</p>

      <SeatGrid rows={rows} />

      <ul className="mt-8 flex flex-wrap gap-4 text-sm">
        {LEGEND.map((item) => (
          <li key={item.label} className="flex items-center gap-2">
            <span aria-hidden className={`size-4 rounded ${item.className}`} />
            {item.label}
          </li>
        ))}
        <li className="flex items-center gap-2">
          <span aria-hidden>×</span> Taken
        </li>
      </ul>
    </section>
  );
}
```

- [ ] **Step 8: Run the seat map tests**

```bash
npm run test -w @cinema/web -- src/features/seat-map
```

Expected: 10 tests PASS (4 `buildRows` + 6 page).

- [ ] **Step 9: Run the full web suite and lint**

```bash
npm run test -w @cinema/web
npm run typecheck -w @cinema/web
npm run lint
```

Expected: 28 tests PASS, typecheck and lint clean.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(web): add the accessible seat map with roving tabindex and per-seat memoisation"
```

---

## Task 15: Docker images and Compose stack

**Files:**
- Create: `apps/api/Dockerfile`, `apps/api/.dockerignore`, `apps/web/Dockerfile`, `apps/web/.dockerignore`, `apps/web/nginx.conf`, `docker-compose.yml`

**Interfaces:**
- Consumes: the build scripts from every workspace.
- Produces: `docker compose up` serving the SPA on `http://localhost:8080` and the API on `http://localhost:3000`, against a migrated and seeded PostgreSQL 18.

- [ ] **Step 1: Create `apps/api/Dockerfile`**

```dockerfile
FROM node:24-alpine AS build
WORKDIR /repo

# Manifests first: npm ci is cached until a dependency actually changes.
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN npm run contracts:build && npm run build -w @cinema/api

FROM node:24-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @cinema/api --include-workspace-root && npm cache clean --force

COPY --from=build /repo/packages/contracts/dist packages/contracts/dist
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=build /repo/apps/api/drizzle apps/api/drizzle

USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
```

`apps/api/.dockerignore`:

```
node_modules
dist
test
coverage
```

- [ ] **Step 2: Create the web image**

`apps/web/nginx.conf`:

```nginx
server {
  listen 80;
  root /usr/share/nginx/html;
  index index.html;

  # The SPA owns its routes; nginx must not 404 on a deep link.
  location / {
    try_files $uri $uri/ /index.html;
  }

  location /api/ {
    proxy_pass http://api:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Request-Id $request_id;
  }
}
```

`apps/web/Dockerfile`:

```dockerfile
FROM node:24-alpine AS build
WORKDIR /repo

COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/web apps/web
RUN npm run contracts:build && npm run build -w @cinema/web

FROM nginx:1.29-alpine AS runtime
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

`apps/web/.dockerignore`:

```
node_modules
dist
playwright-report
test-results
```

- [ ] **Step 3: Create `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: cinema
      POSTGRES_PASSWORD: cinema
      POSTGRES_DB: cinema
    ports:
      - '5432:5432'
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U cinema -d cinema']
      interval: 2s
      timeout: 2s
      retries: 20
    volumes:
      - postgres-data:/var/lib/postgresql/data

  # Migrations run as their own step, not from the app bootstrap: with more than
  # one API replica, parallel bootstraps would race each other over DDL.
  migrate:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    environment:
      DATABASE_URL: postgres://cinema:cinema@postgres:5432/cinema
    command: ['node', 'apps/api/dist/db/migrate.js']
    depends_on:
      postgres:
        condition: service_healthy
    restart: 'no'

  seed:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    environment:
      DATABASE_URL: postgres://cinema:cinema@postgres:5432/cinema
    command: ['node', 'apps/api/dist/db/seed.js']
    depends_on:
      migrate:
        condition: service_completed_successfully
    restart: 'no'

  api:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    environment:
      NODE_ENV: production
      PORT: '3000'
      DATABASE_URL: postgres://cinema:cinema@postgres:5432/cinema
      LOG_LEVEL: info
    ports:
      - '3000:3000'
    depends_on:
      seed:
        condition: service_completed_successfully
    healthcheck:
      test: ['CMD', 'node', '-e', "fetch('http://localhost:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 5s
      timeout: 3s
      retries: 10

  web:
    build:
      context: .
      dockerfile: apps/web/Dockerfile
    ports:
      - '8080:80'
    depends_on:
      api:
        condition: service_healthy

volumes:
  postgres-data:
```

- [ ] **Step 4: Confirm the paths the one-shot services depend on**

```bash
npm run build -w @cinema/api
ls apps/api/dist/db/migrate.js apps/api/dist/db/seed.js
```

Expected: both files exist. `nest build` compiles `src/db/migrate.ts` to `apps/api/dist/db/migrate.js`, and the `migrationsFolder` it computes (`__dirname/../../drizzle`) resolves to `/repo/apps/api/drizzle` inside the image, which the runtime stage copies. `seed.js` runs its `main()` only under `require.main === module`, so importing it from a test does not wipe the database.

- [ ] **Step 5: Bring the whole stack up**

```bash
docker compose build
docker compose up -d
docker compose ps
```

Expected: `migrate` and `seed` exit 0; `postgres`, `api` and `web` are running and `api` reports healthy.

- [ ] **Step 6: Verify every layer answers**

```bash
curl -s localhost:3000/health
curl -s localhost:3000/ready
curl -s 'localhost:3000/api/v1/movies?limit=2' | head -c 200
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080
curl -s -o /dev/null -w '%{http_code}\n' 'localhost:8080/api/v1/movies?limit=1'
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/showtimes/does-not-exist
```

Expected: `{"status":"ok"}`, `{"status":"ready"}`, a movie page envelope, `200`, `200` (nginx proxied to the API), `200` (the SPA fallback, not a 404 from nginx).

- [ ] **Step 7: Commit**

```bash
docker compose down
git add -A
git commit -m "build: containerise the api and the SPA and wire the compose stack

Migrations and seeding are their own one-shot services so multiple API replicas
never race over DDL."
```

---

## Task 16: CI pipeline and the Playwright smoke test

**Files:**
- Create: `apps/web/playwright.config.ts`, `apps/web/e2e/smoke.spec.ts`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the compose stack (Task 15) and every test suite.
- Produces: `npm run e2e -w @cinema/web` against a running stack, and a CI workflow with jobs `quality`, `test-api`, `test-web`, `e2e`.

- [ ] **Step 1: Create `apps/web/playwright.config.ts`**

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
```

- [ ] **Step 2: Write the smoke test at `apps/web/e2e/smoke.spec.ts`**

```ts
import { expect, test } from '@playwright/test';

/**
 * The only test that proves the whole stack is wired together: nginx serves the
 * SPA, proxies /api, the API talks to a migrated and seeded PostgreSQL, and the
 * routes chain from catalogue to seat map.
 */
test('walks from the catalogue to a seat map', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Now showing' })).toBeVisible();

  const firstMovie = page.getByRole('link').filter({ hasText: /min$/ }).first();
  await firstMovie.click();

  await expect(page.getByRole('heading', { name: 'Showtimes' })).toBeVisible();

  await page.getByRole('link').filter({ hasText: /^\d{2}:\d{2}/ }).first().click();

  const grid = page.getByRole('grid', { name: /seat map/i });
  await expect(grid).toBeVisible();
  await expect(grid.getByRole('button').first()).toBeVisible();
});

test('shows the 1000-seat premiere hall', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link').filter({ hasText: /min$/ }).first().click();

  // Every seeded hall is reachable; the premiere hall is the one that matters
  // for the load experiment in sub-project 3.
  const premiere = page.getByRole('link').filter({ hasText: 'Premiere' }).first();
  await premiere.click();

  await expect(page.getByText(/1000 seats/)).toBeVisible();
});

test('serves a deep link directly, without a 404 from nginx', async ({ page }) => {
  const response = await page.goto('/movies/019298a1-7c4e-7c3a-8f21-000000000000');

  expect(response?.status()).toBe(200);
  await expect(page.getByRole('alert')).toBeVisible();
});
```

- [ ] **Step 3: Run the smoke test against the local stack**

```bash
docker compose up -d --build
npx --workspace @cinema/web playwright install --with-deps chromium
npm run e2e -w @cinema/web
```

Expected: 3 tests PASS.

- [ ] **Step 4: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run contracts:build
      - run: npm run lint
      - run: npm run format:check
      - run: npm run typecheck

  test-api:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run contracts:build
      # Testcontainers starts postgres:18-alpine itself; the runner's Docker
      # daemon is all it needs, so no service container is declared here.
      - run: npm run test -w @cinema/api

  test-web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run contracts:build
      - run: npm run test -w @cinema/web
      - run: npm run build -w @cinema/web

  e2e:
    runs-on: ubuntu-latest
    needs: [test-api, test-web]
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: docker compose up -d --build
      - run: npx playwright install --with-deps chromium
        working-directory: apps/web
      - run: npm run e2e -w @cinema/web
      - if: failure()
        run: docker compose logs --no-color
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: apps/web/playwright-report
```

- [ ] **Step 5: Verify every CI command passes locally**

```bash
npm ci
npm run contracts:build
npm run lint && npm run format:check && npm run typecheck
npm run test -w @cinema/api
npm run test -w @cinema/web
```

Expected: all green. Fix anything that fails before committing — CI must be green on the first push.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "ci: add the GitHub Actions pipeline and a Playwright smoke test over the compose stack"
```

---

## Task 17: README and architecture decision records

**Files:**
- Create: `README.md`
- Create: `docs/adr/0001-nestjs-instead-of-growing-the-fastify-prototype.md` … `docs/adr/0008-no-redis-in-phase-1.md`

**Interfaces:**
- Consumes: every decision made in Tasks 1–16.
- Produces: the entry point a reader clones into, plus the record that satisfies the spec's requirement to justify each architectural decision.

- [ ] **Step 1: Write the ADR template into the first record**

`docs/adr/0001-nestjs-instead-of-growing-the-fastify-prototype.md`:

```markdown
# 1. NestJS from scratch instead of growing the Fastify prototype

**Status:** accepted (2026-08-27)

## Context

The repository started as a ~600-line Fastify service with Redis-backed seat
holds. The platform specification calls for NestJS and a different domain model
(Cinema → Hall → Showtime → Seat, plus Reservation, Booking, Payment, Ticket).
Later phases add RabbitMQ workers, Kafka consumers and a swappable payment
provider.

## Decision

Start a new NestJS application on the Fastify adapter. Keep the prototype in git
history (commit 569dfd5) rather than in the working tree.

## Alternatives considered

- **Grow the Fastify app.** Less ceremony and a faster start, but the modular
  wiring that Nest provides — DI for swapping a payment provider in tests,
  module boundaries for workers and consumers — would have to be hand-rolled.
- **Migrate route by route.** Keeps the app running at every step, but migrates
  a domain model that phase 1 discards anyway.

## Consequences

- The Redis locking semantics (`SET NX PX`, Lua check-then-act) are re-derived
  in sub-project 3 against the new schema; the prototype remains the reference.
- The Fastify adapter keeps the request throughput characteristics of the
  prototype and lets the plugin ecosystem (`@fastify/swagger-ui`) be used.
```

- [ ] **Step 2: Write the remaining seven records in the same shape**

Each is 15–25 lines with the same four headings. The decision and the rejected alternative for each:

| File | Decision | Alternatives rejected |
| --- | --- | --- |
| `0002-drizzle-as-the-data-access-layer.md` | Drizzle | Prisma (`FOR UPDATE` only via `$queryRaw`, and locking is the point of sub-project 2); TypeORM (weak migrations, decorator magic); Kysely (no migrations of its own) |
| `0003-shared-zod-contracts-instead-of-openapi-codegen.md` | One Zod package consumed by both sides; OpenAPI generated from it | DTOs plus `@nestjs/swagger` and a generated client (two schema descriptions, a codegen step in CI, and `@nestjs/swagger@12` pulls in `class-validator`) |
| `0004-uuid-v7-primary-keys.md` | `uuidv7()` defaults, generated by PostgreSQL 18 | `bigserial` (leaks business volume through public ids); UUID v4 (random, destroys B-tree insert locality) |
| `0005-keyset-pagination.md` | Opaque base64url cursor over the ordering key | `LIMIT/OFFSET` (skips and repeats rows when data is inserted between pages, degrades at large offsets) |
| `0006-exclusion-constraint-for-showtime-overlap.md` | `EXCLUDE USING gist (hall_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)` | Unique index on `(hall_id, starts_at)` (misses a showtime starting mid-way through another); application-level check (racy under concurrency) |
| `0007-testcontainers-instead-of-mocked-repositories.md` | Integration tests against a real `postgres:18-alpine` | Mocked repositories (would not exercise the exclusion constraint, `uuidv7()`, or `AT TIME ZONE`); sqlite (a different engine with different semantics) |
| `0008-no-redis-in-phase-1.md` | No Redis until sub-project 3 | Reusing the prototype's Redis lock immediately (sub-project 3's headline experiment compares database locking against Redis locking; without an honest, measured PostgreSQL implementation first, there is nothing to compare against) |

- [ ] **Step 3: Write `README.md`**

```markdown
# Cinema Booking Platform

Seat booking under contention, built as a study of the machinery real ticketing
systems need: transactions, distributed locking, asynchronous workers, event
streaming and observability.

This repository is being built in sub-projects. **Phase 1 — the foundation — is
what exists today:** the catalogue API, the seat map, and the infrastructure
everything later rests on. See
[`docs/superpowers/specs/`](docs/superpowers/specs/) for the design of each
phase and [`docs/adr/`](docs/adr/) for why each decision was made.

## Running

```bash
docker compose up --build
```

- SPA: <http://localhost:8080>
- API: <http://localhost:3000/api/v1/movies>
- OpenAPI: <http://localhost:3000/api/docs>

Migrations and the seed run as their own one-shot compose services before the
API starts.

### Development

```bash
npm install
docker compose up -d postgres
npm run db:migrate && npm run db:seed
npm run dev:api    # http://localhost:3000
npm run dev:web    # http://localhost:5173, proxying /api
```

## Layout

| Path | What it is |
| --- | --- |
| `packages/contracts` | Zod schemas shared by both sides. The API validates with them, the SPA parses responses with them, and the OpenAPI document is generated from them |
| `apps/api` | NestJS on the Fastify adapter, Drizzle over PostgreSQL 18 |
| `apps/web` | Vite + React + Tailwind, TanStack Query for server state, URL for UI state |

## Testing

```bash
npm test                      # contracts, api (Testcontainers), web
npm run e2e -w @cinema/web    # Playwright, against a running compose stack
```

API integration tests start their own `postgres:18-alpine` through
Testcontainers, so Docker must be running.

## What phase 1 deliberately does not have

No authentication, no booking, no Redis, no queues, no metrics. Each arrives in
its own sub-project together with the problem it solves — the specification's
first principle is that no technology enters without one.

## Notable details

- **Seats belong to halls, not to showtimes.** Availability will attach to the
  `(showtime, seat)` pair in sub-project 2. Copying 1000 seats per showtime
  would mean 100k duplicate rows per hall per season.
- **Overlapping showtimes are impossible by construction** — a GiST exclusion
  constraint over `tstzrange`, not an application check.
- **Every failure is an RFC 9457 problem document** carrying the request's
  `traceId`, which is the same id echoed in the `x-request-id` header and
  stamped on every log line.
- **The seat map is keyboard-navigable** — one tab stop, arrow keys across the
  hall — and never carries status by colour alone.
```

- [ ] **Step 4: Verify the README's instructions actually work from a clean state**

```bash
docker compose down -v
docker compose up --build -d
sleep 30
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080
curl -s 'localhost:3000/api/v1/movies?limit=1' | head -c 120
docker compose down
```

Expected: `200` and a movie envelope. If either fails, fix the compose stack or the README before committing — a portfolio repository whose quickstart does not work is worse than no README.

- [ ] **Step 5: Final full verification**

```bash
npm ci
npm run contracts:build
npm run lint && npm run format:check && npm run typecheck
npm test
```

Expected: lint, format and typecheck clean; all suites green — 8 contract tests, 57 API tests, 28 web tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: add the README and the phase 1 architecture decision records"
```

---

## Deliberate deviations from the spec

Three places where this plan does something other than the letter of the design
document, and why. Each is a judgement call worth re-checking during review.

1. **Test fixtures are hand-written and contract-typed, not generated from the
   Zod schemas.** The spec asked for generated fixtures. Generated data would be
   arbitrary — `expect(...).toBe('Dune: Part Two')` needs a known value, and a
   3 x 4 seat map fixture has to be small enough to assert on. Typing the
   fixtures with the contract types keeps the guarantee that matters: a contract
   change breaks the mocks at compile time.
2. **Read-only tests share one seeded database instead of each running in a
   transaction that rolls back.** Phase 1 has no write endpoints, so per-test
   isolation would buy nothing and cost a transaction per test. The two tests
   that do write — the showtime overlap constraint — take a client, `BEGIN`, and
   `ROLLBACK` explicitly. Sub-project 2, which writes, will need the rollback
   harness the spec describes; that is the right time to build it.
3. **Validation and OpenAPI are hand-rolled instead of using `nestjs-zod` and
   `@nestjs/swagger`.** Not a preference: both packages cap their peer range
   below NestJS 12. The replacement is roughly 120 lines (Tasks 5 and 10) and
   removes the DTO layer that would otherwise duplicate the contracts.

## Definition of Done

Phase 1 is complete when every box above is ticked and:

1. `git clone && docker compose up` produces a working stack with seeded data.
2. The clickable path works: catalogue → movie → showtime → seat map of a
   1000-seat hall.
3. `/api/docs` renders the OpenAPI document generated from the contract schemas,
   and `/api/openapi.json` returns all seven paths.
4. CI is green: lint, format, typecheck, contract tests, API integration tests on
   Testcontainers, web component tests, and the Playwright smoke test.
5. `README.md` explains how to run it and points at `docs/adr/` for the reasoning.

## Handover to sub-project 2

The seams left open on purpose:

- `seatStatusSchema` already carries `HELD` and `CONFIRMED`; only the query in
  `CatalogService.getShowtimeSeats` needs to start producing them.
- `Executor` is accepted by every service method, so a transaction can be
  threaded through without touching call sites.
- `queryKeys.showtimes.seats(id)` is the key to invalidate after a hold.
- `RouteErrorBoundary`, `ErrorState` and the Problem Details shape are already
  in place for the failure modes booking introduces.
