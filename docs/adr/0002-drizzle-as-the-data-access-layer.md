# 2. Drizzle as the data access layer

**Status:** accepted (2026-08-27)

## Context

Sub-project 2 is about transactions and row locking: `SELECT ... FOR UPDATE`,
explicit transaction boundaries, and a repository layer that can be handed
either a pool or a transaction. Phase 1 has to pick the layer those will be
written against.

## Decision

Use Drizzle ORM with `drizzle-kit` for migrations. Every service method takes an
`Executor = Database | transaction`, defaulting to the pool.

## Alternatives considered

- **Prisma.** `FOR UPDATE` is only reachable through `$queryRaw`, which drops
  back to untyped SQL exactly where the project's hardest problem lives.
- **TypeORM.** Weak migration story and decorator-driven mapping that hides the
  SQL the project is meant to study.
- **Kysely.** A good query builder, but brings no migration tooling of its own.

## Consequences

- Queries read close to SQL, which is the point: `AT TIME ZONE`, row-value
  comparisons and the GiST exclusion constraint are all expressible.
- `drizzle-kit generate --custom` carries the SQL that the schema DSL cannot
  express, such as the exclusion constraint in ADR 6.
