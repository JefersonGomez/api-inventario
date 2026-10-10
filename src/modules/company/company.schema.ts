import { z } from "zod";

export const updateCompanySchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export const createCompanySchema = updateCompanySchema;
