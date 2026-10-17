// Same reproduction as ../repro.ts, on Prisma 6.19.3 (no driver adapter; the database URL is passed directly).
import 'dotenv/config'
import pg from 'pg'
import { PrismaClient as ForeignKeysClient } from './generated/fk/index.js'
import { PrismaClient as EmulatedClient } from './generated/emulated/index.js'

const FK_URL = process.env.FK_DATABASE_URL!
const EMULATED_URL = process.env.EMULATED_DATABASE_URL!

// Print the SQL Prisma sends, but only for Bob's updateMany.
let printSql = false
const log = [{ emit: 'event' as const, level: 'query' as const }]
const onQuery = (e: { query: string; params: string }) => {
  if (printSql) console.log(`  SQL: ${e.query}  -- params ${e.params}`)
}

const foreignKeys = new ForeignKeysClient({ datasourceUrl: FK_URL, log })
foreignKeys.$on('query', onQuery)
const emulated = new EmulatedClient({ datasourceUrl: EMULATED_URL, log })
emulated.$on('query', onQuery)

async function race(title: string, prisma: ForeignKeysClient | EmulatedClient, url: string) {
  console.log(`\n${title}`)
  await prisma.product.deleteMany()
  const { id } = await prisma.product.create({ data: { name: 'Sneakers', stock: 1 } })

  // Alice buys the last item and leaves her transaction open, so the row stays locked.
  const alice = new pg.Client({ connectionString: url })
  await alice.connect()
  await alice.query('BEGIN')
  await alice.query('UPDATE "Product" SET "stock" = "stock" - 1 WHERE "id" = $1 AND "stock" > 0', [id])
  const aliceCommits = new Promise((resolve) => setTimeout(resolve, 500)).then(() => alice.query('COMMIT'))

  // Bob buys the same item through Prisma while Alice still holds the lock.
  printSql = true
  const { count } = await prisma.product.updateMany({
    where: { id, stock: { gt: 0 } },
    data: { stock: { decrement: 1 } },
  })
  printSql = false

  await aliceCommits
  await alice.end()
  const { stock } = await prisma.product.findUniqueOrThrow({ where: { id } })
  const verdict = stock < 0 ? '  <- oversold: Alice and Bob both bought the last item' : ''
  console.log(`  Bob's count = ${count}, stock = ${stock}${verdict}`)
}

await race('relationMode = "foreignKeys"', foreignKeys, FK_URL)
await race('relationMode = "prisma"', emulated, EMULATED_URL)
await foreignKeys.$disconnect()
await emulated.$disconnect()
