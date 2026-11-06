export type UnitStatus = 'not_started' | 'running' | 'stopped' | 'fault'
export type UnitEventType = 'start' | 'stop' | 'resume' | 'fault_reported' | 'fault_resolved'

// أحداث يوم واحد مرتبة تصاعديًا، وكلها قبل لحظة الحساب
export type DomainEvent = {
  type: UnitEventType
  at: number
  faultId?: string | null
  urgent?: boolean | null
  description?: string | null
}

export type Bounds = { start: number; end: number }
export type TimelineSegment = { status: UnitStatus; from: number; to: number }

export type UnitDay = {
  status: UnitStatus
  firstStartAt: number | null
  // ثابت بعد أول تشغيل، وغير معروف قبله
  lateMs: number | null
  // التوقف المغلق حتى الآن (داخل الشيفت فقط)
  downtimeMs: number
  // بداية فترة التوقف الجارية، والعدّاد يكمل منها حتى نهاية الشيفت
  downtimeSince: number | null
  openFault: { id: string; urgent: boolean; description: string | null; reportedAt: number } | null
  segments: TimelineSegment[]
}

type Tracker = {
  status: UnitStatus
  firstStartAt: number | null
  intervalStart: number | null
  downtimeMs: number
}

function overlap(from: number, to: number, bounds: Bounds): number {
  return Math.max(0, Math.min(to, bounds.end) - Math.max(from, bounds.start))
}

function closeInterval(tracker: Tracker, end: number, bounds: Bounds): Tracker {
  if (tracker.intervalStart === null) return tracker
  return {
    ...tracker,
    downtimeMs: tracker.downtimeMs + overlap(tracker.intervalStart, end, bounds),
    intervalStart: null,
  }
}

function applyEvent(tracker: Tracker, event: DomainEvent, bounds: Bounds): Tracker {
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
      // عطل قبل أول تشغيل: بعد إصلاحه تعود الوحدة "لم تبدأ" وتحتاج صورة
      return { ...closed, status: tracker.firstStartAt === null ? 'not_started' : 'running' }
    }
  }
}

function findOpenFault(events: DomainEvent[]): UnitDay['openFault'] {
  let open: DomainEvent | null = null
  for (const event of events) {
    if (event.type === 'fault_reported') open = event
    if (event.type === 'fault_resolved') open = null
  }
  if (!open) return null
  return {
    id: open.faultId ?? `f-${open.at}`,
    urgent: open.urgent ?? false,
    description: open.description ?? null,
    reportedAt: open.at,
  }
}

export function computeUnitDay(events: DomainEvent[], bounds: Bounds, asOfMs: number): UnitDay {
  let tracker: Tracker = {
    status: 'not_started',
    firstStartAt: null,
    intervalStart: null,
    downtimeMs: 0,
  }
  let statusAtShiftStart: UnitStatus = 'not_started'
  const changes: { at: number; status: UnitStatus }[] = []
  const windowEnd = Math.min(asOfMs, bounds.end)

  for (const event of events) {
    tracker = applyEvent(tracker, event, bounds)
    if (event.at <= bounds.start) statusAtShiftStart = tracker.status
    else if (event.at < windowEnd) changes.push({ at: event.at, status: tracker.status })
  }

  const segments: TimelineSegment[] = []
  if (windowEnd > bounds.start) {
    let cursor = bounds.start
    let status = statusAtShiftStart
    for (const change of changes) {
      segments.push({ status, from: cursor, to: change.at })
      cursor = change.at
      status = change.status
    }
    segments.push({ status, from: cursor, to: windowEnd })
  }

  return {
    status: tracker.status,
    firstStartAt: tracker.firstStartAt,
    lateMs: tracker.firstStartAt === null ? null : Math.max(0, tracker.firstStartAt - bounds.start),
    downtimeMs: tracker.downtimeMs,
    downtimeSince:
      tracker.intervalStart === null ? null : Math.max(tracker.intervalStart, bounds.start),
    openFault: findOpenFault(events),
    segments,
  }
}