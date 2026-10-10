// company.routes.ts
import { Router } from "express";
import { Authenticated, Authorize } from "../../middlewares/authenticate.middleware.ts";
import { validate } from "../../middlewares/validate.middleware.ts";
import { updateCompanySchema, createCompanySchema } from "./company.schema.ts";
import {
  getCompanyHandler, updateCompanyHandler, listMyCompaniesHandler, createCompanyHandler,
} from "./company.controller.ts";

// /company = empresa activa
export const companyRouter = Router();
companyRouter.get("/", Authenticated, getCompanyHandler);
companyRouter.put("/", validate(updateCompanySchema), Authenticated, Authorize("ADMIN"), updateCompanyHandler);

// /companies = empresas del usuario (cambiar de empresa: POST /auth/switch-company)
export const companiesRouter = Router();
companiesRouter.get("/", Authenticated, listMyCompaniesHandler);
companiesRouter.post("/", validate(createCompanySchema), Authenticated, createCompanyHandler);
