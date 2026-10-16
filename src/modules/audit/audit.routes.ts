import { Router } from "express";
import { Can , Authenticated} from "../../middlewares/authenticate.middleware.ts";
import { getAuditLogsHandler, getAuditMetricsHandler } from "./audit.controller.ts";
import { validateQuery } from "../../middlewares/validate.middleware.ts";
import { auditListQuerySchema } from "./audit.service.ts";

export const auditRouter = Router();

// "metrics" antes que cualquier ruta con :id, por la regla que ya conocés
auditRouter.get("/metrics", Authenticated, Can("audit.view"), getAuditMetricsHandler);
auditRouter.get("/", validateQuery(auditListQuerySchema), Authenticated, Can("audit.view"), getAuditLogsHandler);