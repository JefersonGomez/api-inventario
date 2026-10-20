// company.routes.ts
import { Router } from "express";
import { Authenticated, Can } from "../../middlewares/authenticate.middleware.ts";
import { validate } from "../../middlewares/validate.middleware.ts";
import { updateCompanySchema, createCompanySchema } from "./company.schema.ts";
import {
  getCompanyHandler, updateCompanyHandler, listMyCompaniesHandler, createCompanyHandler, onboardingHandler, dismissOnboardingHandler,
} from "./company.controller.ts";

// /company = empresa activa
export const companyRouter = Router();
companyRouter.get("/", Authenticated, getCompanyHandler);
// guía de primeros pasos: la ve y la oculta quien administra la empresa
companyRouter.get("/onboarding", Authenticated, Can("company.manage"), onboardingHandler);
companyRouter.put("/onboarding", Authenticated, Can("company.manage"), dismissOnboardingHandler);
companyRouter.put("/", validate(updateCompanySchema), Authenticated, Can("company.manage"), updateCompanyHandler);

// /companies = empresas del usuario (cambiar de empresa: POST /auth/switch-company)
export const companiesRouter = Router();
companiesRouter.get("/", Authenticated, listMyCompaniesHandler);
companiesRouter.post("/", validate(createCompanySchema), Authenticated, createCompanyHandler);
