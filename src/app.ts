import Express from "express"
import { router as authRouter } from "./modules/auth/auth.routes.ts"
import { router as categoryRouter } from "./modules/categories/category.routes.ts"
import { router as productRouter } from "./modules/products/products.routes.ts"
import { router as reportRouter } from "./modules/reports/report.routes.ts"
import { router as movementRouter } from "./modules/movements/mevemenst.routes.ts"
import fs from "fs"
import {parse} from "yaml"
import swaggerUi from "swagger-ui-express"
import path from 'node:path';
const app = Express()
app.use(Express.json())


app.use("/auth",authRouter)
app.use("/categories", categoryRouter)
app.use("/products", productRouter)
app.use("/reports", reportRouter)
app.use("/movements", movementRouter)
app.get("/health",(req, res)=>{
    res.status(200).json({"status":"ok"})
})

const openapiPath = path.join(process.cwd(), 'openapi.yaml');
const file = fs.readFileSync(openapiPath, 'utf8');
const documentParse = parse(file);

// ✅ Pasa swaggerUi.serve y swaggerUi.setup() juntos en app.use
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(documentParse));


export default app;