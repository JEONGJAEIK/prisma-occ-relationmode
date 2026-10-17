import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/emulated.prisma',
  datasource: { url: env('EMULATED_DATABASE_URL') },
})
