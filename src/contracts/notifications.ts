import { z } from 'zod'

export const notificationKindSchema = z.enum([
  'fault_new',
  'arrival_pending',
  'arrival_confirmed',
  'repair_pending',
  'repair_rejected',
  'escalation',
  'unit_started',
  'fault_watch',
  'repair_confirmed',
  'production_added',
  'target_updated',
  'app_update',
])
export type NotificationKind = z.infer<typeof notificationKindSchema>

export const notificationSchema = z.object({
  id: z.string(),
  kind: notificationKindSchema,
  title: z.string(),
  body: z.string(),
  at: z.string(),
  read: z.boolean(),
  link: z.string(),
})
export type AppNotification = z.infer<typeof notificationSchema>

export const notificationListSchema = z.object({
  items: z.array(notificationSchema),
  unreadCount: z.number(),
})

export const unreadCountSchema = z.object({ unreadCount: z.number() })

export const notificationCategorySchema = z.object({
  kind: notificationKindSchema,
  label: z.string(),
  description: z.string(),
  mandatory: z.boolean(),
  enabled: z.boolean(),
})

export const notificationSettingsSchema = z.object({
  categories: z.array(notificationCategorySchema),
})

export const updateNotificationSettingRequestSchema = z.object({ enabled: z.boolean() })
