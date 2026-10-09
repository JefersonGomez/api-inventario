import "dotenv/config"
import { createServer } from "node:http"
import app from "./app.js"
import { initRealtime } from "./shared/realtime.ts"

const dbUrl = process.env.DATABASE_URL!

const httpServer = createServer(app)
initRealtime(httpServer)

httpServer.listen(3000,()=>{
    console.log("servidor corriendo en el puerto 3000")
})
