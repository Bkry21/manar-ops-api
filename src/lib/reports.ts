import { prisma } from '../db'
import { dayBoundsMs, eachDay } from '../domain/sudan-time'
import { sizesForDepartment } from '../domain/product-sizes'
import { effectiveTarget } from './production-targets'
import { toFaultDto } from './fault-dto'
import {
  computeUnitStateOnDay,
  shiftBoundsForDay,
} from './unit-state'
import { currentSettings } from './settings-cache'

const SUDAN_OFFSET_MS = 2 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export type Quantities = Record<string, number>

function normalize(departmentId: string, quantities: Quantities): Quantities {
  return Object.fromEntries(
    sizesForDepartment(departmentId).map((size) => [size.id, quantities[size.id] ?? 0]),
  )
}

export async function buildProductionReport(from: string, to: string, nowMs: number) {
  const days = eachDay(from, to)
  const departments = await prisma.department.findMany({
    where: { active: true },
    orderBy: { createdAt: 'asc' },
  })

  const entries = await prisma.productionEntry.findMany({
    where: { departmentId: { in: departments.map((d) => d.id) }, day: { in: days } },
  })
  const entryKey = (departmentId: string, day: string) => `${departmentId}|${day}`
  const entryMap = new Map(entries.map((item) => [entryKey(item.departmentId, item.day), item]))

  const departmentReports = await Promise.all(
    departments.map(async (department) => ({
      departmentId: department.id,
      name: department.name,
      sizes: sizesForDepartment(department.id),
      days: await Promise.all(
        days.map(async (day) => ({
          day,
          produced: normalize(
            department.id,
            (entryMap.get(entryKey(department.id, day))?.quantities as Quantities | undefined) ?? {},
          ),
          target: await effectiveTarget(department.id, day),
        })),
      ),
    })),
  )

  return {
    from,
    to: days.at(-1) ?? from,
    generatedAt: new Date(nowMs).toISOString(),
    departments: departmentReports,
  }
}

export function monthBounds(month: string): { from: string; to: string } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month)
  if (!match) return null
  const year = Number(match[1])
  const monthIndex = Number(match[2]) - 1
  if (monthIndex < 0 || monthIndex > 11) return null
  return {
    from: new Date(Date.UTC(year, monthIndex, 1)).toISOString().slice(0, 10),
    to: new Date(Date.UTC(year, monthIndex + 1, 0)).toISOString().slice(0, 10),
  }
}

export async function buildOperationsReport(month: string, from: string, to: string, nowMs: number) {
  const days = eachDay(from, to)

  const faultsRaw = await prisma.fault.findMany({
    include: { unit: true },
    where: {
      reportedAt: { gte: new Date(dayBoundsMs(from).start), lt: new Date(dayBoundsMs(to).end) },
    },
    orderBy: { reportedAt: 'asc' },
  })
  const faults = faultsRaw.map((fault) => toFaultDto(fault, nowMs))

  const units = await prisma.unit.findMany()

  const unitReports = await Promise.all(
    units.map(async (unit) => {
      const perDay: { startMinutes: number | null; lateMs: number; downtimeMs: number }[] = []

      for (const day of days) {
        const { start, end } = dayBoundsMs(day)
        const events = await prisma.unitEvent.findMany({
          where: { unitId: unit.id, at: { gte: new Date(start), lt: new Date(end) } },
          orderBy: { at: 'asc' },
        })
        const state = computeUnitStateOnDay(events, day, nowMs)
        const shiftEnd = shiftBoundsForDay(day).end
        // اليوم الجاري بشيفت لم ينتهِ ولم تبدأ فيه الوحدة بعد: لا يُحسب
        if (state.firstStartAt === null && nowMs < shiftEnd) continue

        perDay.push({
          startMinutes:
            state.firstStartAt === null
              ? null
              : ((state.firstStartAt + SUDAN_OFFSET_MS) % DAY_MS) / 60_000,
          lateMs: state.lateMs ?? 0,
          downtimeMs: state.downtimeMs,
        })
      }

      const started = perDay.filter((item) => item.startMinutes !== null)
      const late = perDay.filter((item) => item.lateMs >= 60_000)
      return {
        unitId: unit.id,
        unitName: unit.name,
        daysCounted: perDay.length,
        daysStarted: started.length,
        daysNotRegistered: perDay.length - started.length,
        lateDays: late.length,
        totalLateMs: late.reduce((total, item) => total + item.lateMs, 0),
        avgStartMinutes:
          started.length > 0
            ? started.reduce((total, item) => total + (item.startMinutes ?? 0), 0) / started.length
            : null,
        downtimeMs: perDay.reduce((total, item) => total + item.downtimeMs, 0),
        faultCount: faults.filter((fault) => fault.unitId === unit.id).length,
      }
    }),
  )

  const technicianMap = new Map<string, { name: string; faultCount: number; maintenanceMs: number }>()
  for (const fault of faults) {
    for (const technician of fault.technicians) {
      if (technician.arrivalConfirmedAt === null) continue
      const running = technician.workingSince
        ? Math.max(0, nowMs - Date.parse(technician.workingSince))
        : 0
      const current = technicianMap.get(technician.userId)
      technicianMap.set(technician.userId, {
        name: technician.name,
        faultCount: (current?.faultCount ?? 0) + 1,
        maintenanceMs: (current?.maintenanceMs ?? 0) + technician.maintenanceMs + running,
      })
    }
  }

  return {
    month,
    from,
    to,
    generatedAt: new Date(nowMs).toISOString(),
    shiftStartHour: currentSettings().shiftStartHour,
shiftEndHour: currentSettings().shiftEndHour,
    units: unitReports,
    faults: faults.map((fault) => ({
      id: fault.id,
      unitName: fault.unitName,
      urgent: fault.urgent,
      status: fault.status,
      reportedAt: fault.reportedAt,
      closedAt: fault.closedAt,
      responseMs: fault.responseMs,
      repairMs: fault.repairMs,
      durationMs: (fault.closedAt ? Date.parse(fault.closedAt) : nowMs) - Date.parse(fault.reportedAt),
      technicianNames: fault.technicians.map((technician) => technician.name),
    })),
    technicians: [...technicianMap.entries()].map(([userId, value]) => ({ userId, ...value })),
  }
}