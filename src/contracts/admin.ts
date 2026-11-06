import { z } from 'zod'
import { roleSchema } from './auth'

export const adminUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  fullName: z.string(),
  role: roleSchema,
  departmentId: z.string().nullable(),
  unitIds: z.array(z.string()),
  active: z.boolean(),
  mustChangePassword: z.boolean(),
})
export type AdminUser = z.infer<typeof adminUserSchema>
export const adminUserListSchema = z.array(adminUserSchema)

const passwordSchema = z.string().min(8).max(64)

export const createUserRequestSchema = z.object({
  fullName: z.string().trim().min(2).max(60),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9._-]{3,30}$/),
  role: roleSchema,
  departmentId: z.string().nullable(),
  unitIds: z.array(z.string()),
  password: passwordSchema,
})
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>

export const updateUserRequestSchema = z.object({
  fullName: z.string().trim().min(2).max(60),
  role: roleSchema,
  departmentId: z.string().nullable(),
  unitIds: z.array(z.string()),
  active: z.boolean(),
})
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>

export const resetPasswordRequestSchema = z.object({ password: passwordSchema })
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>

export const adminUnitSchema = z.object({
  id: z.string(),
  name: z.string(),
  departmentId: z.string(),
  photoHint: z.string(),
  operatorId: z.string().nullable(),
  operatorName: z.string().nullable(),
})
export type AdminUnit = z.infer<typeof adminUnitSchema>
export const adminUnitListSchema = z.array(adminUnitSchema)

export const createUnitRequestSchema = z.object({
  name: z.string().trim().min(2).max(40),
  departmentId: z.string(),
  photoHint: z.string().trim().max(120),
  operatorId: z.string().nullable(),
})
export type CreateUnitRequest = z.infer<typeof createUnitRequestSchema>

export const updateUnitRequestSchema = z.object({
  name: z.string().trim().min(2).max(40),
  photoHint: z.string().trim().max(120),
  operatorId: z.string().nullable(),
})
export type UpdateUnitRequest = z.infer<typeof updateUnitRequestSchema>
