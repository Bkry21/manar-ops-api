import { describe, expect, it } from 'vitest'
import { SUDAN_OFFSET_MS, shiftBounds } from './sudan-time.js'
import { computeUnitDay } from './unit-state.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

// وقت بتوقيت السودان في يوم الاختبار
const at = (time: string) => Date.parse(`2026-11-02T${time}:00Z`) - SUDAN_OFFSET_MS
// الشيفت من 7 صباحًا إلى 5 مساءً
const bounds = shiftBounds(at('12:00'), 7, 17)

describe('computeUnitDay', () => {
  it('وحدة لم تبدأ بعد', () => {
    const day = computeUnitDay([], bounds, at('12:00'))
    expect(day.status).toBe('not_started')
    expect(day.lateMs).toBeNull()
    expect(day.segments).toEqual([{ status: 'not_started', from: bounds.start, to: at('12:00') }])
  })

  it('تأخير ساعة وتوقف نصف ساعة ثم إعادة تشغيل', () => {
    const day = computeUnitDay(
      [
        { type: 'start', at: at('08:00') },
        { type: 'stop', at: at('10:00') },
        { type: 'resume', at: at('10:30') },
      ],
      bounds,
      at('12:00'),
    )
    expect(day.status).toBe('running')
    expect(day.firstStartAt).toBe(at('08:00'))
    expect(day.lateMs).toBe(HOUR)
    expect(day.downtimeMs).toBe(30 * MINUTE)
    expect(day.downtimeSince).toBeNull()
    expect(day.segments).toEqual([
      { status: 'not_started', from: at('07:00'), to: at('08:00') },
      { status: 'running', from: at('08:00'), to: at('10:00') },
      { status: 'stopped', from: at('10:00'), to: at('10:30') },
      { status: 'running', from: at('10:30'), to: at('12:00') },
    ])
  })

  it('بدء قبل الشيفت لا يُحسب تأخيرًا، والتوقف يتوقف عند نهاية الشيفت', () => {
    const day = computeUnitDay(
      [
        { type: 'start', at: at('06:30') },
        { type: 'stop', at: at('16:00') },
      ],
      bounds,
      at('18:00'),
    )
    expect(day.status).toBe('stopped')
    expect(day.lateMs).toBe(0)
    expect(day.downtimeMs).toBe(0)
    expect(day.downtimeSince).toBe(at('16:00'))
    expect(day.segments).toEqual([
      { status: 'running', from: at('07:00'), to: at('16:00') },
      { status: 'stopped', from: at('16:00'), to: at('17:00') },
    ])
  })

  it('عطل قبل أول تشغيل: يُحسب توقفًا، ثم تعود الوحدة لتحتاج صورة', () => {
    const day = computeUnitDay(
      [
        { type: 'fault_reported', at: at('07:30'), faultId: 'f1' },
        { type: 'fault_resolved', at: at('09:00') },
        { type: 'start', at: at('09:30') },
      ],
      bounds,
      at('12:00'),
    )
    expect(day.status).toBe('running')
    expect(day.downtimeMs).toBe(90 * MINUTE)
    expect(day.lateMs).toBe(2.5 * HOUR)
    expect(day.openFault).toBeNull()
  })

  it('عطل عاجل مفتوح', () => {
    const day = computeUnitDay(
      [
        { type: 'start', at: at('08:00') },
        {
          type: 'fault_reported',
          at: at('09:00'),
          faultId: 'f2',
          urgent: true,
          description: 'تسريب',
        },
      ],
      bounds,
      at('10:00'),
    )
    expect(day.status).toBe('fault')
    expect(day.downtimeSince).toBe(at('09:00'))
    expect(day.openFault).toEqual({
      id: 'f2',
      urgent: true,
      description: 'تسريب',
      reportedAt: at('09:00'),
    })
  })
})