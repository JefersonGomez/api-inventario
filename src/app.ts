import Express from "express"
import { router as authRouter } from "./modules/auth/auth.routes.ts"
import { router as categoryRouter } from "./modules/categories/category.routes.ts"
import { router as productRouter } from "./modules/products/products.routes.ts"
import { router as reportRouter } from "./modules/reports/report.routes.ts"
const app = Express()
app.use(Express.json())


app.use("/auth",authRouter)
app.use("/categories", categoryRouter)
app.use("/products", productRouter)
app.use("/reports", reportRouter)
app.get("/health",(req, res)=>{
    res.status(200).json({"status":"ok"})
})



export default app;