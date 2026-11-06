import { prisma } from '../db'

export type SystemSettings = {
  shiftStartHour: number
  shiftEndHour: number
  escalationUrgentMinutes: number
  escalationNormalMinutes: number
}

const defaults: SystemSettings = {
  shiftStartHour: 7,
  shiftEndHour: 17,
  escalationUrgentMinutes: 5,
  escalationNormalMinutes: 10,
}

let cache: SystemSettings = { ...defaults }

export function currentSettings(): SystemSettings {
  return cache
}

export function setCurrentSettings(next: SystemSettings): void {
  cache = next
}

export async function loadSettingsIntoCache(): Promise<void> {
  const row = await prisma.systemSettings.findUnique({ where: { id: 'singleton' } })
  if (row) {
    cache = {
      shiftStartHour: row.shiftStartHour,
      shiftEndHour: row.shiftEndHour,
      escalationUrgentMinutes: row.escalationUrgentMinutes,
      escalationNormalMinutes: row.escalationNormalMinutes,
    }
  }
}