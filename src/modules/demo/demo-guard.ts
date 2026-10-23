// Candado de la demo pública, en un archivo aparte (sin dependencias) para que usuarios, códigos y accesos
// lo usen sin importar todo el generador de la demo.
import { prismaRoot } from "../../config/database.ts"

// La cuenta demo no cambia correo, código ni accesos (si no, se la bloquearía a quien la pruebe después)
export async function assertNotDemoUser(userId: string) {
  const u = await prismaRoot.user.findUnique({ where: { id: userId }, select: { isDemo: true } })
  if (u?.isDemo) throw Object.assign(new Error("En la demo no se pueden cambiar los datos de acceso de las cuentas de ejemplo"), { status: 403 })
}
