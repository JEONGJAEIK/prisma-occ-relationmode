# `updateMany` drops its `where` filter under `relationMode = "prisma"`

Reported as [prisma/orm#30758](https://github.com/prisma/orm/issues/30758).

With `relationMode = "prisma"`, `updateMany` first selects the matching ids and then runs
`UPDATE ... WHERE id IN (...) AND 1=1`. The original `where` filter is not applied to the `UPDATE`, so a row that
stopped matching between the two statements is still updated and still counted.

Any "update only if the condition still holds, then check `count`" code is affected. In this repro a product has
1 item left, and buying it is:

```ts
const { count } = await prisma.product.updateMany({
  where: { id, stock: { gt: 0 } },
  data: { stock: { decrement: 1 } },
})
// count 1 = bought, count 0 = sold out
```

Two concurrent buyers both get `count: 1`, and stock ends at `-1`.

This is [prisma/orm#21867](https://github.com/prisma/orm/issues/21867) (labelled `bug/2-confirmed`, closed in the
December 2024 cleanup), reproduced deterministically on PostgreSQL with the latest Prisma 7.

## Run

Requires Docker and Node.js 24.

```sh
npm install
npm run db:up    # PostgreSQL 18 on localhost:54329, one database per relationMode
npm run setup    # generate both clients and create the Product table
npm run repro
```

[`repro.ts`](repro.ts) is the whole reproduction. Alice buys the last item in her own transaction and keeps the
row locked for 500 ms. While she holds the lock, Bob runs the `updateMany` above through Prisma, and the script
prints the SQL Prisma sends for it. The two schemas in `prisma/` define the same `Product` model (no relations) and
differ only in `relationMode`.

## Output

Prisma 7.10.1, PostgreSQL 18.6:

```
relationMode = "foreignKeys"
  SQL: UPDATE "public"."Product" SET "stock" = ("public"."Product"."stock" - $1) WHERE ("public"."Product"."id" = $2 AND "public"."Product"."stock" > $3)  -- params [1,8,0]
  Bob's count = 0, stock = 0

relationMode = "prisma"
  SQL: SELECT "public"."Product"."id" FROM "public"."Product" WHERE ("public"."Product"."id" = $1 AND "public"."Product"."stock" > $2) OFFSET $3  -- params [8,0,"0"]
  SQL: UPDATE "public"."Product" SET "stock" = ("public"."Product"."stock" - $1) WHERE ("public"."Product"."id" IN ($2) AND 1=1)  -- params [1,8]
  SQL: COMMIT  -- params []
  Bob's count = 1, stock = -1  <- oversold: Alice and Bob both bought the last item
```

The result is the same on every run. Prisma 6.19.3 gives the same SQL and result
(`cd prisma6 && npm install && npm run setup && npm run repro`, after `db:up` and `setup` in the root).
`npm run db:logs` shows the statements as the PostgreSQL server received them.

## Why

Under READ COMMITTED the `SELECT` takes no lock, so it still sees `stock = 1` while Alice's transaction is open.
The `UPDATE` then waits for Alice's row lock. When it resumes, PostgreSQL re-checks the `UPDATE`'s own `WHERE`
against the new row version. That `WHERE` is only `id IN (...)`, so it still matches and stock goes from 0 to -1.
With `stock > 0` in the `UPDATE` (as in `foreignKeys` mode) the re-check fails and the count is 0.

In the query compiler, `update_many_records` gives the `UPDATE` node `Filter::empty()` when relations are emulated:
[`query-compiler/core/src/query_graph_builder/write/update.rs` L132–L175](https://github.com/prisma/prisma-engines/blob/d1b3f377ca835d73fd50954a5e22128b9ebdd6b8/query-compiler/core/src/query_graph_builder/write/update.rs#L132-L175)
(the filter goes only to the pre-read at L146–L150; the `UPDATE` gets `Filter::empty()` at L154).
`delete_many_records` builds the same select-then-write plan but keeps the original filter on the `DELETE`:
[`delete.rs` L129–L156](https://github.com/prisma/prisma-engines/blob/d1b3f377ca835d73fd50954a5e22128b9ebdd6b8/query-compiler/core/src/query_graph_builder/write/delete.rs#L129-L156).
Commit `d1b3f377` is the engines version used by Prisma 7.10.1.

## Expected

`updateMany` should apply its `where` filter to the `UPDATE` as well, as `deleteMany` does, so that `count` only
includes rows that still matched when they were written. Bob would then get `count: 0` and stock would stay at 0,
the same as with `foreignKeys`.

A fix would also need to check the emulated `onUpdate` actions (`insert_emulated_on_update`), which are planned
from the pre-read ids: if the `UPDATE` writes fewer rows than were pre-read, those actions should not run for the
rows that were skipped.

The optimistic concurrency control example in the Prisma docs
([Optimistic concurrency control](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions#optimistic-concurrency-control),
`updateMany` with a `version` condition) is the same pattern and is affected in the same way.
