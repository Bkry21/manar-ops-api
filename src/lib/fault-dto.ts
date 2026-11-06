import type { Fault as PrismaFault, Unit } from '../generated/prisma/client'

export type StoredInterval = { from: number; to: number | null }
export type StoredTechnician = {
  userId: string
  name: string
  arrivedAt: number
  arrivalConfirmedAt: number | null
  confirmedBy: string | null
  finishedAt: number | null
  intervals: StoredInterval[]
}
export type StoredLogEntry = { at: number; text: string }

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

export function deriveStatus(
  fault: PrismaFault,
): 'reported' | 'arrival_pending' | 'under_repair' | 'repair_pending' | 'closed' {
  if (fault.closedAt !== null) return 'closed'
  const technicians = (fault.technicians as unknown as StoredTechnician[]) ?? []
  if (technicians.some((item) => item.finishedAt !== null)) return 'repair_pending'
  if (technicians.some((item) => item.intervals.some((interval) => interval.to === null))) {
    return 'under_repair'
  }
  if (technicians.some((item) => item.arrivalConfirmedAt === null)) return 'arrival_pending'
  return 'reported'
}

export function toFaultDto(fault: PrismaFault & { unit: Unit }, nowMs: number) {
  const technicians = (fault.technicians as unknown as StoredTechnician[]) ?? []
  const log = (fault.log as unknown as StoredLogEntry[]) ?? []
  const reportedAtMs = fault.reportedAt.getTime()
  const closedAtMs = fault.closedAt?.getTime() ?? null

  const arrivals = technicians.map((item) => item.arrivedAt)
  const confirmations = technicians.flatMap((item) =>
    item.arrivalConfirmedAt === null ? [] : [item.arrivalConfirmedAt],
  )

  return {
    id: fault.id,
    unitId: fault.unitId,
    unitName: fault.unit.name,
    departmentId: fault.unit.departmentId,
    urgent: fault.urgent,
    description: fault.description,
    status: deriveStatus(fault),
    reportedAt: iso(reportedAtMs),
    reportedByName: fault.reportedByName,
    closedAt: closedAtMs === null ? null : iso(closedAtMs),
    responseMs: arrivals.length > 0 ? Math.min(...arrivals) - reportedAtMs : null,
    repairMs:
      closedAtMs !== null && confirmations.length > 0
        ? closedAtMs - Math.min(...confirmations)
        : null,
    technicians: technicians.map((item) => {
      const openInterval = item.intervals.find((interval) => interval.to === null)
      return {
        userId: item.userId,
        name: item.name,
        arrivedAt: iso(item.arrivedAt),
        arrivalConfirmedAt: item.arrivalConfirmedAt === null ? null : iso(item.arrivalConfirmedAt),
        confirmedBy: item.confirmedBy,
        finishedAt: item.finishedAt === null ? null : iso(item.finishedAt),
        maintenanceMs: item.intervals.reduce(
          (sum, interval) => (interval.to === null ? sum : sum + (interval.to - interval.from)),
          0,
        ),
        workingSince: openInterval ? iso(openInterval.from) : null,
      }
    }),
    log: log.map((entry) => ({ at: iso(entry.at), text: entry.text })),
    serverNow: iso(nowMs),
  }
}

export function faultVisibleTo(
  auth: { role: string; unitIds: string[]; departmentId: string | null },
  fault: { unitId: string; unit: Unit },
): boolean {
  switch (auth.role) {
    case 'operator':
      return auth.unitIds.includes(fault.unitId)
    case 'technician':
    case 'supervisor':
      return auth.departmentId === fault.unit.departmentId
    case 'production_manager':
    case 'factory_manager':
      return true
    default:
      return false
  }
}