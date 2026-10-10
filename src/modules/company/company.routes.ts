// company.routes.ts
import { Router } from "express";
import { Authenticated, Authorize } from "../../middlewares/authenticate.middleware.ts";
import { validate } from "../../middlewares/validate.middleware.ts";
import { updateCompanySchema } from "./company.schema.ts";
import { getCompanyHandler, updateCompanyHandler } from "./company.controller.ts";

export const companyRouter = Router();
companyRouter.get("/", Authenticated, getCompanyHandler);
companyRouter.put("/", validate(updateCompanySchema), Authenticated, Authorize("ADMIN"), updateCompanyHandler);
