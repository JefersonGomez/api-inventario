import { Router } from "express";
import { Authorize , Authenticated} from "../../middlewares/authenticate.middleware.ts";
import { getAuditLogsHandler, getAuditMetricsHandler } from "./audit.controller.ts";

export const auditRouter = Router();

// "metrics" antes que cualquier ruta con :id, por la regla que ya conocés
auditRouter.get("/metrics", Authenticated, Authorize("ADMIN"), getAuditMetricsHandler);
auditRouter.get("/", Authenticated, Authorize("ADMIN"), getAuditLogsHandler);