import { z } from 'zod'

export const roleSchema = z.enum([
  'operator',
  'technician',
  'supervisor',
  'production_manager',
  'factory_manager',
])
export type Role = z.infer<typeof roleSchema>

export const userSchema = z.object({
  id: z.string(),
  username: z.string(),
  fullName: z.string(),
  role: roleSchema,
  departmentId: z.string().nullable(),
  unitIds: z.array(z.string()),
  mustChangePassword: z.boolean(),
})
export type User = z.infer<typeof userSchema>

export const loginRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})
export type LoginRequest = z.infer<typeof loginRequestSchema>

export const loginResponseSchema = z.object({
  token: z.string(),
  user: userSchema,
})
export type LoginResponse = z.infer<typeof loginResponseSchema>

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(64),
})
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>
