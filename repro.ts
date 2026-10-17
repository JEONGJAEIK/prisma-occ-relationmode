// updateMany loses its `where` filter under relationMode = "prisma".
//
// A product has 1 item in stock. Alice buys it in her own transaction and keeps the row locked for 500 ms.
// While she holds the lock, Bob buys it with Prisma: "decrement stock only if stock > 0", and `count`
// says whether he got it. Expected for Bob: count 0 (sold out), stock stays 0.
import 'dotenv/config'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient as ForeignKeysClient } from './generated/fk/client.ts'
import { PrismaClient as EmulatedClient } from './generated/emulated/client.ts'

const FK_URL = process.env.FK_DATABASE_URL!
const EMULATED_URL = process.env.EMULATED_DATABASE_URL!

// Print the SQL Prisma sends, but only for Bob's updateMany.
let printSql = false
const log = [{ emit: 'event' as const, level: 'query' as const }]
const onQuery = (e: { query: string; params: string }) => {
  if (printSql) console.log(`  SQL: ${e.query}  -- params ${e.params}`)
}

const foreignKeys = new ForeignKeysClient({ adapter: new PrismaPg({ connectionString: FK_URL }), log })
foreignKeys.$on('query', onQuery)
const emulated = new EmulatedClient({ adapter: new PrismaPg({ connectionString: EMULATED_URL }), log })
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
