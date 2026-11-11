// Cifrado de secretos guardados en la base (credenciales de Hacienda, llaves .p12): AES-256-GCM con una
// llave derivada de EINVOICE_SECRET (variable del servidor, mínimo 32 caracteres; nunca en el repo).
// Formato: "v1:<iv>:<tag>:<datos>" en base64. Si alguien copia la base sin el .env, no puede leerlos.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"

function key() {
  const secret = process.env.EINVOICE_SECRET ?? ""
  if (secret.length < 32) {
    throw Object.assign(new Error("Falta EINVOICE_SECRET en el servidor (mínimo 32 caracteres) para guardar credenciales cifradas"), { status: 500, code: "SECRET_NOT_CONFIGURED" })
  }
  return createHash("sha256").update(secret).digest()
}

export function seal(data: Buffer | string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key(), iv)
  const body = Buffer.concat([cipher.update(typeof data === "string" ? Buffer.from(data, "utf8") : data), cipher.final()])
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(":")
}

export function open(sealed: string): Buffer {
  const [v, iv, tag, body] = sealed.split(":")
  if (v !== "v1" || !iv || !tag || body === undefined) throw new Error("Secreto guardado con un formato desconocido")
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"))
    decipher.setAuthTag(Buffer.from(tag, "base64"))
    return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()])
  } catch {
    throw new Error("No se pudo descifrar un secreto guardado (¿cambió EINVOICE_SECRET?)")
  }
}

export const openText = (sealed: string) => open(sealed).toString("utf8")
