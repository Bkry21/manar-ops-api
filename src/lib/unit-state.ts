import type { UnitEvent as PrismaUnitEvent } from '../generated/prisma/client'
import { currentSettings } from './settings-cache'

const HOUR_MS = 60 * 60 * 1000
const SUDAN_OFFSET_MS = 2 * HOUR_MS

export type UnitStatus = 'not_started' | 'running' | 'stopped' | 'fault'
type Bounds = { start: number; end: number }
type Tracker = {
  status: UnitStatus
  firstStartAt: number | null
  intervalStart: number | null
  downtimeMs: number
}

export function shiftBounds(nowMs: number): Bounds {
  const { shiftStartHour, shiftEndHour } = currentSettings()
  const sudanNow = new Date(nowMs + SUDAN_OFFSET_MS)
  const sudanMidnight =
    Date.UTC(sudanNow.getUTCFullYear(), sudanNow.getUTCMonth(), sudanNow.getUTCDate()) - SUDAN_OFFSET_MS
  return { start: sudanMidnight + shiftStartHour * HOUR_MS, end: sudanMidnight + shiftEndHour * HOUR_MS }
}

export function shiftBoundsForDay(day: string): Bounds {
  const { shiftStartHour, shiftEndHour } = currentSettings()
  const dayStart = Date.parse(`${day}T00:00:00Z`) - SUDAN_OFFSET_MS
  return { start: dayStart + shiftStartHour * HOUR_MS, end: dayStart + shiftEndHour * HOUR_MS }
}

export function sudanDayBounds(nowMs: number): { dayStart: number; dayEnd: number } {
  const sudanNow = new Date(nowMs + SUDAN_OFFSET_MS)
  const sudanMidnight =
    Date.UTC(sudanNow.getUTCFullYear(), sudanNow.getUTCMonth(), sudanNow.getUTCDate()) - SUDAN_OFFSET_MS
  return { dayStart: sudanMidnight, dayEnd: sudanMidnight + 24 * HOUR_MS }
}

function overlap(from: number, to: number, bounds: Bounds): number {
  return Math.max(0, Math.min(to, bounds.end) - Math.max(from, bounds.start))
}

function closeInterval(tracker: Tracker, end: number, bounds: Bounds): Tracker {
  if (tracker.intervalStart === null) return tracker
  return { ...tracker, downtimeMs: tracker.downtimeMs + overlap(tracker.intervalStart, end, bounds), intervalStart: null }
}

function applyEvent(tracker: Tracker, event: { type: string; at: number }, bounds: Bounds): Tracker {
  switch (event.type) {
    case 'start':
      return { ...tracker, status: 'running', firstStartAt: tracker.firstStartAt ?? event.at }
    case 'resume':
      return { ...closeInterval(tracker, event.at, bounds), status: 'running' }
    case 'stop':
      return { ...tracker, status: 'stopped', intervalStart: event.at }
    case 'fault_reported':
      return { ...tracker, status: 'fault', intervalStart: tracker.intervalStart ?? event.at }
    case 'fault_resolved': {
      const closed = closeInterval(tracker, event.at, bounds)
      return { ...closed, status: closed.firstStartAt === null ? 'not_started' : 'running' }
    }
    default:
      return tracker
  }
}

function findOpenFault(events: PrismaUnitEvent[]) {
  let open: PrismaUnitEvent | null = null
  for (const event of events) {
    if (event.type === 'fault_reported') open = event
    if (event.type === 'fault_resolved') open = null
  }
  if (!open) return null
  return { id: open.faultId ?? open.id, urgent: open.urgent, description: open.description, reportedAt: open.at.toISOString() }
}

export function computeDayState(
  unit: { id: string; name: string; photoHint: string },
  events: PrismaUnitEvent[],
  startPhotoUrl: string | null,
  nowMs: number,
) {
  const bounds = shiftBounds(nowMs)
  let tracker: Tracker = { status: 'not_started', firstStartAt: null, intervalStart: null, downtimeMs: 0 }
  for (const event of events) tracker = applyEvent(tracker, { type: event.type, at: event.at.getTime() }, bounds)

  return {
    unitId: unit.id,
    unitName: unit.name,
    photoHint: unit.photoHint,
    status: tracker.status,
    serverNow: new Date(nowMs).toISOString(),
    shiftStart: new Date(bounds.start).toISOString(),
    shiftEnd: new Date(bounds.end).toISOString(),
    firstStartAt: tracker.firstStartAt === null ? null : new Date(tracker.firstStartAt).toISOString(),
    lateMs: tracker.firstStartAt === null ? null : Math.max(0, tracker.firstStartAt - bounds.start),
    startPhotoUrl,
    downtimeMs: tracker.downtimeMs,
    downtimeSince: tracker.intervalStart === null ? null : new Date(Math.max(tracker.intervalStart, bounds.start)).toISOString(),
    openFault: findOpenFault(events),
    events: events.map((event) => ({ type: event.type, at: event.at.toISOString(), urgent: event.urgent })),
  }
}

export type TimelineSegment = { status: UnitStatus; from: string; to: string }

export function buildSegments(events: PrismaUnitEvent[], bounds: Bounds, asOfMs: number): TimelineSegment[] {
  const windowEnd = Math.min(asOfMs, bounds.end)
  if (windowEnd <= bounds.start) return []

  let tracker: Tracker = { status: 'not_started', firstStartAt: null, intervalStart: null, downtimeMs: 0 }
  let statusAtStart: UnitStatus = 'not_started'
  const changes: { at: number; status: UnitStatus }[] = []

  for (const event of events) {
    const at = event.at.getTime()
    tracker = applyEvent(tracker, { type: event.type, at }, bounds)
    if (at <= bounds.start) statusAtStart = tracker.status
    else if (at < windowEnd) changes.push({ at, status: tracker.status })
  }

  const segments: TimelineSegment[] = []
  let cursor = bounds.start
  let status = statusAtStart
  for (const change of changes) {
    segments.push({ status, from: new Date(cursor).toISOString(), to: new Date(change.at).toISOString() })
    cursor = change.at
    status = change.status
  }
  segments.push({ status, from: new Date(cursor).toISOString(), to: new Date(windowEnd).toISOString() })
  return segments
}

// نفس منطق computeDayState لكن لأي يوم ماضٍ، بدل ما يبقى دايمًا "اليوم الحالي"
export function computeUnitStateOnDay(
  events: PrismaUnitEvent[],
  day: string,
  nowMs: number,
): { firstStartAt: number | null; lateMs: number | null; downtimeMs: number } {
  const bounds = shiftBoundsForDay(day)
  let tracker: Tracker = { status: 'not_started', firstStartAt: null, intervalStart: null, downtimeMs: 0 }
  for (const event of events) tracker = applyEvent(tracker, { type: event.type, at: event.at.getTime() }, bounds)

  const asOfMs = Math.min(nowMs, bounds.end)
  const openDowntime =
    tracker.intervalStart !== null ? Math.max(0, asOfMs - Math.max(tracker.intervalStart, bounds.start)) : 0

  return {
    firstStartAt: tracker.firstStartAt,
    lateMs: tracker.firstStartAt === null ? null : Math.max(0, tracker.firstStartAt - bounds.start),
    downtimeMs: tracker.downtimeMs + openDowntime,
  }
}