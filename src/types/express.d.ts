export interface AuthPayload {
  id: string;
  companyId: string;
  role: string; // rol del usuario EN esa empresa (sale de Membership, no del token)
  permissions: string[]; // permisos efectivos en esa empresa: rol + ajustes de la persona
  isPlatformOwner?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}
