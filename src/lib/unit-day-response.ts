import type { Unit, UnitEvent as PrismaUnitEvent } from '../generated/prisma/client'
import { dayBoundsMs, shiftBounds } from '../domain/sudan-time'
import { computeUnitDay, type DomainEvent } from '../domain/unit-state'

const SHIFT_START_HOUR = 7
const SHIFT_END_HOUR = 17

function toDomainEvents(events: PrismaUnitEvent[]): DomainEvent[] {
  return events.map((event) => ({
    type: event.type,
    at: event.at.getTime(),
    faultId: event.faultId,
    urgent: event.urgent,
    description: event.description,
  }))
}

function buildFromBounds(
  unit: Pick<Unit, 'id' | 'name' | 'photoHint'>,
  events: PrismaUnitEvent[],
  bounds: { start: number; end: number },
  nowMs: number,
) {
  const day = computeUnitDay(toDomainEvents(events), bounds, nowMs)
  const startEvent = events.find((event) => event.type === 'start')

  return {
    unitId: unit.id,
    unitName: unit.name,
    photoHint: unit.photoHint,
    status: day.status,
    serverNow: new Date(nowMs).toISOString(),
    shiftStart: new Date(bounds.start).toISOString(),
    shiftEnd: new Date(bounds.end).toISOString(),
    firstStartAt: day.firstStartAt === null ? null : new Date(day.firstStartAt).toISOString(),
    lateMs: day.lateMs,
    startPhotoUrl: startEvent?.startPhotoUrl ?? null,
    downtimeMs: day.downtimeMs,
    downtimeSince: day.downtimeSince === null ? null : new Date(day.downtimeSince).toISOString(),
    openFault:
      day.openFault === null ? null : { ...day.openFault, reportedAt: new Date(day.openFault.reportedAt).toISOString() },
    events: events.map((event) => ({ type: event.type, at: event.at.toISOString(), urgent: event.urgent })),
    segments: day.segments.map((segment) => ({
      status: segment.status,
      from: new Date(segment.from).toISOString(),
      to: new Date(segment.to).toISOString(),
    })),
  }
}

export function buildUnitDayResponse(unit: Pick<Unit, 'id' | 'name' | 'photoHint'>, events: PrismaUnitEvent[], nowMs: number) {
  const bounds = shiftBounds(nowMs, SHIFT_START_HOUR, SHIFT_END_HOUR)
  const { segments, ...rest } = buildFromBounds(unit, events, bounds, nowMs)
  return rest
}

export function buildUnitSegments(unit: Pick<Unit, 'id' | 'name' | 'photoHint'>, events: PrismaUnitEvent[], nowMs: number) {
  const bounds = shiftBounds(nowMs, SHIFT_START_HOUR, SHIFT_END_HOUR)
  return buildFromBounds(unit, events, bounds, nowMs).segments
}

export function buildUnitOverviewForDay(
  unit: Pick<Unit, 'id' | 'name' | 'photoHint'>,
  events: PrismaUnitEvent[],
  day: string,
  departmentId: string,
  realNowMs: number,
) {
  const bounds = shiftBounds(dayBoundsMs(day).start, SHIFT_START_HOUR, SHIFT_END_HOUR)
  return { ...buildFromBounds(unit, events, bounds, realNowMs), departmentId }
}