import { Server } from "socket.io";
import type { Server as HttpServer } from "node:http";
import jwt from "jsonwebtoken";
import { prismaRoot } from "../config/database.ts";
import { corsOrigins } from "../config/cors.ts";
import { jwtSecret } from "../config/env.ts";
import { currentCompanyIdOrNull } from "./tenant.ts";

// El socket no transporta datos: solo avisa "esto cambió" y el cliente vuelve a pedirlo por la API normal.
// Los topics son las raíces de las queryKey de react-query del frontend.
let io: Server | null = null;

export const ADMINS = "role:ADMIN";
export const EVERYONE = ["role:ADMIN", "role:EMPLOYE"];
export const userRoom = (id: string) => `user:${id}`;
const companyRoom = (companyId: string, room: string) => `company:${companyId}:${room}`;

// lo que cambia cuando se mueve el stock o el catálogo
export const STOCK_TOPICS = [
  "products",
  "movements",
  "reports",
  "stock-forecast",
  "inventory-value-breakdown",
  "notifications",
];
export const REQUEST_TOPICS = ["purchase-requests", "purchase-request-alerts", "notifications"];

export function initRealtime(httpServer: HttpServer) {
  io = new Server(httpServer, { cors: { origin: corsOrigins } });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const payload = jwt.verify(token, jwtSecret()) as { id?: string; companyId?: string };
      if (!payload.id || !payload.companyId) return next(new Error("unauthorized"));
      const membership = await prismaRoot.membership.findUnique({
        where: { userId_companyId: { userId: payload.id, companyId: payload.companyId } },
        include: { user: { select: { isActive: true } } },
      });
      if (!membership?.isActive || !membership.user.isActive) return next(new Error("unauthorized"));
      socket.data.user = { id: payload.id, role: membership.role, companyId: payload.companyId };
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const { id, role, companyId } = socket.data.user;
    socket.join([companyRoom(companyId, `role:${role}`), userRoom(id)]);
  });
}

// Nunca debe romper la petición que lo llama: si el socket falla, la API sigue respondiendo.
// Las salas por rol ("role:ADMIN") son por empresa: se traducen a la empresa activa de la
// petición. Sin empresa activa no se avisa a ningún rol (nunca a todas las empresas).
export function emit(rooms: string | string[], topics: string[]) {
  try {
    const companyId = currentCompanyIdOrNull();
    const targets = (Array.isArray(rooms) ? rooms : [rooms]).flatMap((r) =>
      r.startsWith("role:") ? (companyId ? [companyRoom(companyId, r)] : []) : [r]
    );
    if (targets.length > 0) io?.to(targets).emit("invalidate", topics);
  } catch (error) {
    console.error("realtime emit falló:", error);
  }
}
