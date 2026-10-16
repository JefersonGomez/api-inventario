import Express from "express"
import { router as authRouter } from "./modules/auth/auth.routes.ts"
import { router as categoryRouter } from "./modules/categories/category.routes.ts"
import { router as productRouter } from "./modules/products/products.routes.ts"
import { router as reportRouter } from "./modules/reports/report.routes.ts"
import { router as movementRouter } from "./modules/movements/mevemenst.routes.ts"
import { router as profileRouter } from "./modules/users/profile.routes.ts"
import { router as usersRouter } from "./modules/userGestion/userGestion.routes.ts"
import { router as supplierRouter  } from "./modules/suppliers/supplier.routes.ts"
import { router as customerRouter } from "./modules/customers/customer.routes.ts"
import { authorizationRouter } from "./modules/users/pin.routes.ts"
import { router as productGroupRouter } from "./modules/product-groups/product-group.routes.ts"
import {purchaseOrderRouter as purchaseOrderRouter} from "./modules/purchase-orders/purchase-order.routes.ts"
import{purchaseRequestRouter as purchaseRequestRouter} from "./modules/purchase-requests/purchase-request.routes.ts"
import { auditRouter } from "./modules/audit/audit.routes.ts";
import { assistantRouter } from "./modules/assistant/assistant.routes.ts";
import { notificationsRouter } from "./modules/notifications/notifications.routes.ts"
import { companyRouter, companiesRouter } from "./modules/company/company.routes.ts"
import { invitationRouter } from "./modules/invitations/invitation.routes.ts"
import { platformRouter } from "./modules/platform/platform.routes.ts"
import fs from "fs"
import {parse} from "yaml"
import swaggerUi from "swagger-ui-express"
import path from 'node:path';
import cors from "cors"
import { corsOrigins } from "./config/cors.ts"
import helmet from "helmet"
import { sanitizeErrors, notFound, errorHandler } from "./middlewares/error.middleware.ts"
import { hideCostsWithoutPermission } from "./middlewares/costs.middleware.ts"

const app = Express()
// Detrás de un proxy (Caddy/Nginx) la IP real viene en X-Forwarded-For: TRUST_PROXY = cuántos proxies
// hay delante (normalmente 1). Sin esto el límite de intentos vería la IP del proxy para todos.
app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 0))
app.use(helmet({
  // las fotos de perfil se piden desde otro origen (el frontend)
  crossOriginResourcePolicy: { policy: "cross-origin" },
}))
app.use(cors({
  origin: corsOrigins
}))
// la importación de productos trae su propio parser con un límite mayor (products.routes.ts)
const jsonDefault = Express.json({ limit: "100kb" })
app.use((req, res, next) => (req.path === "/products/import" ? next() : jsonDefault(req, res, next)))
app.use(sanitizeErrors)
app.use(hideCostsWithoutPermission)


app.use("/auth",authRouter)
app.use("/categories", categoryRouter)
app.use("/products", productRouter)
app.use("/reports", reportRouter)
app.use("/movements", movementRouter)
app.use("/profile", profileRouter)
app.use("/uploads", Express.static(path.join(process.cwd(), "uploads")))
app.use("/users", usersRouter)
app.use("/suppliers", supplierRouter)
app.use("/customers", customerRouter)
app.use("/authorizations", authorizationRouter)
app.use("/product-groups", productGroupRouter)
app.use("/purchase-orders",purchaseOrderRouter)
app.use("/purchase-requests", purchaseRequestRouter)
app.use("/audit-logs", auditRouter);
app.use("/assistant", assistantRouter);
app.use("/notifications",notificationsRouter)
app.use("/company", companyRouter)
app.use("/companies", companiesRouter)
app.use("/invitations", invitationRouter)
app.use("/platform", platformRouter)
app.get("/health",(req, res)=>{
    res.status(200).json({"status":"ok"})
})

const openapiPath = path.join(process.cwd(), 'openapi.yaml');
const file = fs.readFileSync(openapiPath, 'utf8');
const documentParse = parse(file);

// ✅ Pasa swaggerUi.serve y swaggerUi.setup() juntos en app.use
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(documentParse));

// siempre al final: ruta inexistente y errores no capturados
app.use(notFound)
app.use(errorHandler)


export default app;