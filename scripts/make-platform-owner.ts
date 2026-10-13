// Marca una cuenta como dueño de la plataforma. Es la ÚNICA forma de hacerlo (no hay endpoint):
//   npm run owner -- correo@ejemplo.com                      (la cuenta ya existe)
//   npm run owner -- correo@ejemplo.com "Tu nombre" "clave"  (la crea con su propia empresa)
// La contraseña también se puede pasar en OWNER_PASSWORD para no dejarla en el historial.
import "dotenv/config"
import { prismaRoot } from "../src/config/database.ts"
import { Register } from "../src/modules/auth/auth.service.ts"
import { newPasswordSchema } from "../src/shared/password.ts"

async function main() {
  const [email, name, passwordArg] = process.argv.slice(2)
  if (!email) {
    console.error("Uso: npm run owner -- correo@ejemplo.com [\"Nombre\" \"contraseña\"]")
    process.exit(1)
  }
  const normalized = email.trim().toLowerCase()

  let user = await prismaRoot.user.findFirst({ where: { email: { equals: normalized, mode: "insensitive" } } })
  if (!user) {
    const password = passwordArg ?? process.env.OWNER_PASSWORD
    if (!name || !password) {
      console.error("La cuenta no existe: pasa también el nombre y la contraseña para crearla.")
      process.exit(1)
    }
    const policy = newPasswordSchema.safeParse(password)
    if (!policy.success) {
      console.error("Contraseña no válida:", policy.error.issues[0]?.message)
      process.exit(1)
    }
    const created = await Register(name, normalized, password, { company: "Stockly (plataforma)" })
    user = await prismaRoot.user.findUniqueOrThrow({ where: { id: created.id } })
    console.log(`Cuenta creada: ${normalized}`)
  }

  await prismaRoot.user.update({ where: { id: user.id }, data: { isPlatformOwner: true } })
  console.log(`Listo: ${normalized} es ahora dueño de la plataforma.`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prismaRoot.$disconnect())
