// Borra y vuelve a crear la ferretería de la demo pública. En la VPS lo corre un cron cada noche:
//   docker compose -f docker-compose.prod.yml exec -T api npm run demo:reset
import "dotenv/config"
import "../src/config/timezone.ts"
import { prismaRoot } from "../src/config/database.ts"
import { resetDemo } from "../src/modules/demo/demo.service.ts"

const started = Date.now()
resetDemo({ log: (m) => console.log(`[demo] ${m}`) })
  .then(() => console.log(`[demo] listo en ${Math.round((Date.now() - started) / 1000)} s`))
  .catch((e) => {
    console.error("[demo] falló:", e)
    process.exitCode = 1
  })
  .finally(() => prismaRoot.$disconnect())
