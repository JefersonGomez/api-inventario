import type { Request, Response } from "express"
import { documentXml, getDocumentEInvoice, refreshDocument, sendDocument } from "./einvoice.service.ts"

type HttpError = Error & { status?: number; code?: string }
const reply = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
  try {
    res.status(200).json(await fn(req))
  } catch (error) {
    const e = error as HttpError
    res.status(e.status ?? 400).json({ error: e.message, ...(e.code && { code: e.code }) })
  }
}

export const getEInvoiceHandler = reply((req) => getDocumentEInvoice(String(req.params.id)))
export const sendEInvoiceHandler = reply((req) => sendDocument(String(req.params.id), req.user!.id))
export const refreshEInvoiceHandler = reply((req) => refreshDocument(String(req.params.id)))

export async function xmlEInvoiceHandler(req: Request, res: Response) {
  try {
    const { fileName, xml } = await documentXml(String(req.params.id))
    res.setHeader("Content-Type", "application/xml; charset=utf-8")
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`)
    res.status(200).send(xml)
  } catch (error) {
    const e = error as HttpError
    res.status(e.status ?? 400).json({ error: e.message })
  }
}
