import Express from "express"
import { router as authRouter } from "./modules/auth/auth.routes.ts"
import { router as categoryRouter } from "./modules/categories/category.routes.ts"
import { router as productRouter } from "./modules/products/products.routes.ts"
import { router as reportRouter } from "./modules/reports/report.routes.ts"
import { router as movementRouter } from "./modules/movements/mevemenst.routes.ts"
import { router as profileRouter } from "./modules/users/profile.routes.ts"
import { router as usersRouter } from "./modules/userGestion/userGestion.routes.ts"
import { router as supplierRouter  } from "./modules/suppliers/supplier.routes.ts"
import {purchaseOrderRouter as purchaseOrderRouter} from "./modules/purchase-orders/purchase-order.routes.ts"
import{purchaseRequestRouter as purchaseRequestRouter} from "./modules/purchase-requests/purchase-request.routes.ts"
import fs from "fs"
import {parse} from "yaml"
import swaggerUi from "swagger-ui-express"
import path from 'node:path';
import cors from "cors"

const app = Express()
app.use(cors({
  origin: "http://localhost:5173"
}))
app.use(Express.json())


app.use("/auth",authRouter)
app.use("/categories", categoryRouter)
app.use("/products", productRouter)
app.use("/reports", reportRouter)
app.use("/movements", movementRouter)
app.use("/profile", profileRouter)
app.use("/uploads", Express.static(path.join(process.cwd(), "uploads")))
app.use("/users", usersRouter)
app.use("/suppliers", supplierRouter)
app.use("/purchase-orders",purchaseOrderRouter)
app.use("/purchase-requests", purchaseRequestRouter)
app.get("/health",(req, res)=>{
    res.status(200).json({"status":"ok"})
})

const openapiPath = path.join(process.cwd(), 'openapi.yaml');
const file = fs.readFileSync(openapiPath, 'utf8');
const documentParse = parse(file);

// ✅ Pasa swaggerUi.serve y swaggerUi.setup() juntos en app.use
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(documentParse));


export default app;