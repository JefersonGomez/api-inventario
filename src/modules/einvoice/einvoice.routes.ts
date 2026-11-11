// Facturación electrónica (Bloque 9). Fase 1: enviar y consultar a mano un comprobante ya emitido.
// Fase 2: configuración de la empresa (credenciales y llave .p12 cifradas) y prueba de conexión.
import { Router } from "express"
import multer from "multer"
import { Authenticated, Can } from "../../middlewares/authenticate.middleware.ts"
import { validate } from "../../middlewares/validate.middleware.ts"
import {
  getEInvoiceHandler, getSettingsHandler, refreshEInvoiceHandler, saveSettingsHandler, sendEInvoiceHandler, testSettingsHandler, xmlEInvoiceHandler,
} from "./einvoice.controller.ts"
import { settingsSchema } from "./einvoice-settings.service.ts"

export const router = Router()

// La llave .p12 queda solo en memoria (nunca en disco) hasta cifrarla; pesa unos pocos KB
const keyUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024, files: 1 } })

router.get("/settings", Authenticated, Can("company.manage"), getSettingsHandler)
// multipart: el permiso se revisa antes de recibir el archivo y el cuerpo se valida después de multer
router.put("/settings", Authenticated, Can("company.manage"), keyUpload.single("p12"), validate(settingsSchema), saveSettingsHandler)
router.post("/settings/test", Authenticated, Can("company.manage"), testSettingsHandler)

router.get("/documents/:id", Authenticated, Can("company.manage"), getEInvoiceHandler)
router.get("/documents/:id/xml", Authenticated, Can("company.manage"), xmlEInvoiceHandler)
router.post("/documents/:id/send", Authenticated, Can("company.manage"), sendEInvoiceHandler)
router.post("/documents/:id/refresh", Authenticated, Can("company.manage"), refreshEInvoiceHandler)
