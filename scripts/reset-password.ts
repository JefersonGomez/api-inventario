// Pone una contraseña nueva a una cuenta (para quien la olvidó, mientras no exista "olvidé mi contraseña"):
//   npm run reset-password -- correo@ejemplo.com
// La clave se escribe en la terminal (no queda en el historial). Cierra las sesiones abiertas de esa cuenta.
import "dotenv/config"
import bcrypt from "bcrypt"
import { createInterface } from "node:readline"
import { prismaRoot } from "../src/config/database.ts"
import { newPasswordSchema } from "../src/shared/password.ts"

async function main() {
  const email = process.argv[2]?.trim().toLowerCase()
  if (!email) {
    console.error("Uso: npm run reset-password -- correo@ejemplo.com")
    process.exit(1)
  }
  const user = await prismaRoot.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } } })
  if (!user) {
    console.error(`No existe una cuenta con el correo ${email}`)
    process.exit(1)
  }

  // línea por línea (no rl.question): así también funciona con la entrada redirigida
  const rl = createInterface({ input: process.stdin })
  const lines = rl[Symbol.asyncIterator]()
  const ask = async (label: string) => {
    process.stdout.write(label)
    return String((await lines.next()).value ?? "")
  }
  const password = await ask("Contraseña nueva: ")
  const repeat = await ask("Repítela: ")
  rl.close()
  if (password !== repeat) {
    console.error("No coinciden; no se cambió nada.")
    process.exit(1)
  }
  const policy = newPasswordSchema.safeParse(password)
  if (!policy.success) {
    console.error("Contraseña no válida:", policy.error.issues[0]?.message)
    process.exit(1)
  }

  await prismaRoot.$transaction([
    prismaRoot.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(password, 10) } }),
    prismaRoot.refreshToken.updateMany({ where: { userId: user.id, revoked: false }, data: { revoked: true } }),
  ])
  console.log(`Listo: contraseña cambiada para ${email}. Las sesiones abiertas se cerraron.`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prismaRoot.$disconnect())
