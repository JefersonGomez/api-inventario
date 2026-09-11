import multer, { type FileFilterCallback } from "multer"
import path from "node:path"
import type { Request } from "express"

// 1. Corregido 'starage' por 'storage'
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/avatars")
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname)
    const uniqueFilename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`
    
    // Corregido: Pasar el nombre del archivo generado, NO la ruta de carpetas
    cb(null, uniqueFilename)
  },
})

// 2. Corregido: FileFilterCallback importado desde 'multer'
const fileFilter = (
  req: Request,
  file: Express.Multer.File,
  cb: FileFilterCallback
) => {
  const allowedMimeTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp"]

  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true)
  } else {
    // Corregido: Solo pasar el Error para que coincida con los tipos de TS
    cb(new Error("Formato de archivo no válido. Solo se permiten JPEG, PNG y WEBP."))
  }
}

export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB
  },
})