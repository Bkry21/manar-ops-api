import { z } from 'zod'

export const systemSettingsSchema = z
  .object({
    shiftStartHour: z.number().int().min(0).max(23),
    shiftEndHour: z.number().int().min(1).max(24),
    escalationUrgentMinutes: z.number().int().min(1).max(240),
    escalationNormalMinutes: z.number().int().min(1).max(240),
  })
  .refine((value) => value.shiftEndHour > value.shiftStartHour, {
    message: 'نهاية الشيفت يجب أن تكون بعد بدايته',
    path: ['shiftEndHour'],
  })
export type SystemSettings = z.infer<typeof systemSettingsSchema>

export const activityKindSchema = z.enum([
  'login',
  'login_failed',
  'user',
  'unit',
  'settings',
  'targets',
])
export type ActivityKind = z.infer<typeof activityKindSchema>

export const activityEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  kind: activityKindSchema,
  actorName: z.string(),
  text: z.string(),
})
export type ActivityEntry = z.infer<typeof activityEntrySchema>
export const activityListSchema = z.array(activityEntrySchema)
