import multer, { type FileFilterCallback } from "multer"
import fs from "node:fs/promises"
import type { NextFunction, Request, Response } from "express"

// La extensión sale del tipo validado, NUNCA del nombre que manda el cliente: si no, un
// archivo ".html" con tipo "image/png" quedaría servido desde /uploads y ejecutaría scripts.
const EXT: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" }

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, "uploads/avatars"),
  filename: (_req, file, cb) => {
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${EXT[file.mimetype] ?? ""}`)
  },
})

const fileFilter = (_req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
  if (EXT[file.mimetype]) return cb(null, true)
  const err = new Error("Formato de archivo no válido. Solo se permiten JPEG, PNG y WEBP.") as Error & { status: number }
  err.status = 400
  cb(err)
}

export const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
})

// El tipo que declara el cliente es solo una declaración: se comprueba el contenido real
// (firma del archivo) y, si no es una imagen, se borra lo subido.
function looksLikeImage(head: Buffer) {
  const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
  const png = head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const webp = head.subarray(0, 4).toString("ascii") === "RIFF" && head.subarray(8, 12).toString("ascii") === "WEBP"
  return jpeg || png || webp
}

export async function validateImageContent(req: Request, res: Response, next: NextFunction) {
  const file = req.file
  if (!file) return next()
  try {
    const handle = await fs.open(file.path, "r")
    const head = Buffer.alloc(12)
    await handle.read(head, 0, 12, 0)
    await handle.close()
    if (looksLikeImage(head)) return next()
  } catch {
    // si no se puede leer, se trata como inválido
  }
  await fs.unlink(file.path).catch(() => {})
  res.status(400).json({ error: "El archivo no es una imagen válida" })
}
