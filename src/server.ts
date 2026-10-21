import "dotenv/config"
import { createServer } from "node:http"
import { assertEnv } from "./config/env.ts"
import app from "./app.js"
import { initRealtime } from "./shared/realtime.ts"
import { notifyOverdue } from "./modules/receivables/receivables.service.ts"

// falla al arrancar (con un mensaje claro) si falta algo crítico
assertEnv()

const httpServer = createServer(app)
initRealtime(httpServer)

const port = Number(process.env.PORT) || 3000
httpServer.listen(port, () => {
    console.log(`servidor corriendo en el puerto ${port}`)
})

// aviso de cuotas vencidas: al arrancar y cada hora
const overdue = () => notifyOverdue().catch((e) => console.error("avisos de cuotas vencidas:", e))
overdue()
setInterval(overdue, 3_600_000).unref()
