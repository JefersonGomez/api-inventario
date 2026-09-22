import { prisma } from "../../config/database.ts";
import bcrypt from "bcrypt";
import jwt, { type SignOptions } from "jsonwebtoken";
import crypto from "crypto";

const ACCESS_TOKEN_EXPIRY = "20s";
const REFRESH_TOKEN_EXPIRY_DAYS = 7;

export async function Register(name: string, email: string, password: string) {
  const existingUser = await prisma.user.findUnique({
    where: { email: email },
  });

  if (existingUser) {
    throw new Error("El usuario ya existe");
  }

  const passwordHashed = await bcrypt.hash(password, 10);

  const newUser = await prisma.user.create({
    data: {
      name: name,
      email: email,
      passwordHash: passwordHashed,
      role: "EMPLOYE",
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      avatarUrl: true,
    },
  });

  return newUser;
}
// Helper interno: firma el access token. Se reutiliza en Login y en Refresh.
function signAccessToken (user:{id:string; role:string}){
  const payload = {id:user.id, role: user.role}
  const opciones : SignOptions = {expiresIn: ACCESS_TOKEN_EXPIRY}
  const clave = process.env.JWT_SECRET_KEY ||"clave_secreta_por_defecto_desarrollo"
  return jwt.sign(payload,clave,opciones)
}

// Helper interno: genera y persiste un refresh token nuevo para un usuario
async function createRefreshToken(userId:string) {
  const secret = crypto.randomBytes(40).toString("hex");
   const secretHash = await bcrypt.hash(secret, 10);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const record = await prisma.refreshToken.create({
    data: { userId, tokenHash: secretHash, expiresAt },
  });

  // el token que viaja al cliente: "id.secret" — el id no es sensible,
  // solo sirve para ubicar la fila; el secret es lo que valida la autenticidad
  return `${record.id}.${secret}`;
  
}

export async function Login(email: string, password: string) {
  const existUser = await prisma.user.findUnique({
    where: { email: email },
  });

  if (!existUser) {
    throw new Error("Credenciales invalidas");
  }

  const coinciden = await bcrypt.compare(password, existUser.passwordHash);

  if (!coinciden) {
    throw new Error("Credenciales invalidas");
  }

  if (!existUser.isActive) {
    throw new Error("Tu cuenta ha sido desactivada. Contacta a un administrador.");
  }

  const token = signAccessToken(existUser);
  const refreshToken = await createRefreshToken(existUser.id); // ← nuevo

  return {
    token,
    refreshToken, // ← nuevo
    user: {
      id: existUser.id,
      name: existUser.name,
      email: existUser.email,
      role: existUser.role,
      avatarUrl: existUser.avatarUrl,
    },
  };
}

export async function refreshAccessToken(refreshTokenString: string) {
  const [id, secret] = refreshTokenString.split(".");

  if (!id || !secret) {
    throw new Error("Refresh token inválido");
  }

  const record = await prisma.refreshToken.findUnique({ where: { id } });

  if (!record || record.revoked || record.expiresAt < new Date()) {
    throw new Error("Refresh token inválido o expirado");
  }

  const valid = await bcrypt.compare(secret, record.tokenHash);
  if (!valid) {
    throw new Error("Refresh token inválido");
  }

  const user = await prisma.user.findUnique({ where: { id: record.userId } });
  if (!user || !user.isActive) {
    throw new Error("Usuario no encontrado o inactivo");
  }

  // Rotación: revocamos el refresh token usado y emitimos uno nuevo.
  // Esto significa que cada refresh token sirve una sola vez — si alguien
  // roba uno viejo que ya fue usado, no le sirve de nada.
  await prisma.refreshToken.update({
    where: { id },
    data: { revoked: true },
  });

  const newAccessToken = signAccessToken(user);
  const newRefreshToken = await createRefreshToken(user.id);

  return { token: newAccessToken, refreshToken: newRefreshToken };
}

// ← nueva función completa, para el logout real
export async function logout(refreshTokenString: string) {
  const [id] = refreshTokenString.split(".");
  if (!id) return; // token mal formado, nada que revocar

  await prisma.refreshToken.updateMany({
    where: { id, revoked: false },
    data: { revoked: true },
  });
}