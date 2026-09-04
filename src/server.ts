import "dotenv/config"
import app from "./app.js"

const dbUrl = process.env.DATABASE_URL!

app.listen(3000,()=>{
    console.log("servidor corriendo en el puerto 3000")
})