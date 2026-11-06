const HOUR_MS = 60 * 60 * 1000

// السودان UTC+2 طوال العام (بلا توقيت صيفي)
export const SUDAN_OFFSET_MS = 2 * HOUR_MS

// تاريخ اليوم بتوقيت السودان، مثل: 2026-11-02
export function sudanDayKey(ms: number): string {
  return new Date(ms + SUDAN_OFFSET_MS).toISOString().slice(0, 10)
}

// بداية الشيفت ونهايته (بالميلي ثانية UTC) لليوم الذي يقع فيه هذا الوقت
export function shiftBounds(ms: number, startHour: number, endHour: number) {
  const sudanNow = new Date(ms + SUDAN_OFFSET_MS)
  const sudanMidnight =
    Date.UTC(sudanNow.getUTCFullYear(), sudanNow.getUTCMonth(), sudanNow.getUTCDate()) -
    SUDAN_OFFSET_MS
  return {
    start: sudanMidnight + startHour * HOUR_MS,
    end: sudanMidnight + endHour * HOUR_MS,
  }
}

// آخر لحظة في يوم سوداني محدد
export function endOfDayMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) - SUDAN_OFFSET_MS + 24 * HOUR_MS - 1
}

export function isDayKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
}

export function addDays(dayKey: string, days: number): string {
  return new Date(Date.parse(`${dayKey}T00:00:00Z`) + days * 24 * HOUR_MS).toISOString().slice(0, 10)
}

// حد أقصى للحماية من الفترات الضخمة
export function eachDay(from: string, to: string): string[] {
  const days: string[] = []
  for (let day = from; day <= to && days.length <= 400; day = addDays(day, 1)) days.push(day)
  return days
}

export function dayBoundsMs(day: string): { start: number; end: number } {
  const start = Date.parse(`${day}T00:00:00Z`) - SUDAN_OFFSET_MS
  return { start, end: start + 24 * HOUR_MS }
}