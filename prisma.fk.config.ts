import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/fk.prisma',
  datasource: { url: env('FK_DATABASE_URL') },
})
