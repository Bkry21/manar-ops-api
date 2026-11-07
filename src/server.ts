import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import { z } from 'zod'
import { hash, verify } from '@node-rs/argon2'
import { prisma } from './db'
import { serializeUser } from './lib/serialize-user'
import { authorizeUnit } from './lib/authorize-unit'
import { sizesForDepartment } from './domain/product-sizes'
import { buildOperationsReport, buildProductionReport, monthBounds } from './lib/reports'
import { faultVisibleTo } from './lib/fault-dto'
import { deriveStatus, toFaultDto } from './lib/fault-dto'
import { canReadDepartment } from './lib/production-performance'
import { targetsDto } from './lib/production-targets'
import type { StoredLogEntry, StoredTechnician } from './lib/fault-dto'
import { dayBoundsMs, addDays, eachDay, isDayKey, sudanDayKey } from './domain/sudan-time'
import { computePerformance } from './lib/production-performance'
import { canConfirmFault, loadVisibleFault } from './lib/load-fault'
import { entryDto, saveEntry } from './lib/production-entries'
import {
  applyUnitAssignment,
  assignOperator,
  canManageRole,
  managementRoles,
  normalizeAssignment,
  toAdminUnit,
  toAdminUser,
} from './lib/admin'
import { buildSegments, computeDayState, shiftBounds, sudanDayBounds } from './lib/unit-state'
import {
  catalog as notificationCatalog,
  runEscalations,
  settingsFor,
  notify,
  allManagers,
} from './lib/notifications'
import { currentSettings, loadSettingsIntoCache, setCurrentSettings } from './lib/settings-cache'
import { listActivity, recordActivity, recordLoginFailure } from './lib/activity'

const app = Fastify({ logger: true })

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})

const saveEntryBodySchema = z.object({
  quantities: z.record(z.string(), z.number().int().min(0).max(1_000_000)),
})
const MAX_ENTRY_AGE_DAYS = 7

const systemSettingsBodySchema = z
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

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(64),
})

const startUnitSchema = z.object({ photoDataUrl: z.string().min(1).optional() })
const reportFaultSchema = z.object({ urgent: z.boolean(), description: z.string().optional() })

const confirmArrivalSchema = z.object({ technicianId: z.string() })

const saveTargetsSchema = z.object({
  effectiveFrom: z.string(),
  quantities: z.record(z.string(), z.number().int().min(0).max(1_000_000)),
})

const roleSchema = z.enum([
  'operator',
  'technician',
  'supervisor',
  'production_manager',
  'factory_manager',
])

const createUserBodySchema = z.object({
  fullName: z.string().trim().min(2).max(60),
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,30}$/),
  role: roleSchema,
  departmentId: z.string().nullable(),
  unitIds: z.array(z.string()),
  password: z.string().min(8).max(64),
})

const updateUserBodySchema = z.object({
  fullName: z.string().trim().min(2).max(60),
  role: roleSchema,
  departmentId: z.string().nullable(),
  unitIds: z.array(z.string()),
  active: z.boolean(),
})

const resetPasswordBodySchema = z.object({ password: z.string().min(8).max(64) })
const createUnitBodySchema = z.object({
  name: z.string().trim().min(1).max(60),
  departmentId: z.string(),
  photoHint: z.string().trim().max(200).optional().default(''),
  operatorId: z.string().nullable(),
})

const updateUnitBodySchema = z.object({
  name: z.string().trim().min(1).max(60),
  photoHint: z.string().trim().max(200).optional().default(''),
  operatorId: z.string().nullable(),
})

const updateNotificationSettingSchema = z.object({ enabled: z.boolean() })

async function main() {
 await app.register(cors, {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
})
  await app.register(jwt, { secret: process.env.JWT_SECRET! })

  app.get('/health', async () => ({ status: 'ok', time: new Date().toISOString() }))

    app.addHook('onSend', async (request, reply, payload) => {
    if (reply.statusCode >= 400) return payload

    const routeKey = `${request.method} ${request.routeOptions?.url ?? ''}`
    const auth = (request.user as { sub: string; role: string } | undefined) ?? null
    let result: unknown = null
    if (typeof payload === 'string' && payload.length > 0) {
      try {
        result = JSON.parse(payload)
      } catch {
        result = null
      }
    }

    recordActivity({ routeKey, auth, result, nowMs: Date.now() }).catch((error) =>
      app.log.error(error, 'activity log failed'),
    )

    return payload
  })

  app.post('/auth/login', async (request, reply) => {
    const body = loginSchema.safeParse(request.body)
    if (!body.success) {
      return reply.code(400).send({ code: 'validation_error', message: 'بيانات الدخول غير صحيحة' })
    }

    const user = await prisma.user.findUnique({ where: { username: body.data.username } })
    if (!user) {
      await recordLoginFailure(body.data.username, 'invalid_credentials', Date.now())
      return reply.code(401).send({ code: 'invalid_credentials', message: 'اسم المستخدم أو كلمة المرور غير صحيحة' })
    }

    const valid = await verify(user.passwordHash, body.data.password)
    if (!valid) {
      await recordLoginFailure(body.data.username, 'invalid_credentials', Date.now())
      return reply.code(401).send({ code: 'invalid_credentials', message: 'اسم المستخدم أو كلمة المرور غير صحيحة' })
    }

    const token = app.jwt.sign({ sub: user.id, role: user.role })

    return { token, user: await serializeUser(user.id) }
  })

    app.post('/auth/change-password', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })

    const body = changePasswordSchema.safeParse(request.body)
    if (!body.success) {
      return reply.code(400).send({ code: 'validation_error', message: 'بيانات غير صحيحة' })
    }

    const user = await prisma.user.findUnique({ where: { id: auth.sub } })
    if (!user) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })

    const valid = await verify(user.passwordHash, body.data.currentPassword)
    if (!valid) {
      return reply.code(401).send({ code: 'invalid_credentials', message: 'كلمة السر الحالية غير صحيحة' })
    }

    const newHash = await hash(body.data.newPassword)
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: newHash, mustChangePassword: false },
    })

    return serializeUser(user.id)
  })

    app.get('/units/today', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })

    const readerRoles = ['supervisor', 'production_manager', 'factory_manager']
    if (!readerRoles.includes(auth.role)) {
      return reply.code(403).send({ code: 'forbidden', message: 'لا تملك صلاحية على نظرة الوحدات' })
    }

    const dbUser = await prisma.user.findUnique({ where: { id: auth.sub } })
    const units =
      auth.role === 'supervisor'
        ? await prisma.unit.findMany({ where: { departmentId: dbUser?.departmentId ?? '__none__' } })
        : await prisma.unit.findMany()

    const nowMs = Date.now()
    const { dayStart, dayEnd } = sudanDayBounds(nowMs)

    const result = await Promise.all(
      units.map(async (unit) => {
        const events = await prisma.unitEvent.findMany({
          where: { unitId: unit.id, at: { gte: new Date(dayStart), lt: new Date(dayEnd) } },
          orderBy: { at: 'asc' },
        })
        const startEvent = events.find((event) => event.type === 'start')
        return {
          ...computeDayState(unit, events, startEvent?.startPhotoUrl ?? null, nowMs),
          departmentId: unit.departmentId,
          segments: buildSegments(events, shiftBounds(nowMs), nowMs),
        }
      }),
    )

    return result
  })


  app.get('/units/:unitId/today', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })

    const { unitId } = request.params as { unitId: string }
    const unit = await prisma.unit.findUnique({ where: { id: unitId } })
    if (!unit) return reply.code(404).send({ code: 'unit_not_found', message: 'الوحدة غير موجودة' })

    const dbUser = await prisma.user.findUnique({ where: { id: auth.sub }, include: { units: true } })
    const readerRoles = ['supervisor', 'production_manager', 'factory_manager']
    const ownsUnit = auth.role === 'operator' && dbUser?.units.some((u) => u.id === unitId)
    if (!ownsUnit && !readerRoles.includes(auth.role)) {
      return reply.code(403).send({ code: 'forbidden', message: 'لا تملك صلاحية على هذه الوحدة' })
    }

    const nowMs = Date.now()
    const { dayStart, dayEnd } = sudanDayBounds(nowMs)
    const events = await prisma.unitEvent.findMany({
      where: { unitId, at: { gte: new Date(dayStart), lt: new Date(dayEnd) } },
      orderBy: { at: 'asc' },
    })
    const startEvent = events.find((event) => event.type === 'start')

    return computeDayState(unit, events, startEvent?.startPhotoUrl ?? null, nowMs)
  })

    app.get('/units/:unitId/day/:day', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })

    const { unitId, day } = request.params as { unitId: string; day: string }
    if (!isDayKey(day)) return reply.code(400).send({ code: 'invalid_day', message: 'تاريخ غير صحيح' })

    const unit = await prisma.unit.findUnique({ where: { id: unitId } })
    if (!unit) return reply.code(404).send({ code: 'unit_not_found', message: 'الوحدة غير موجودة' })

    const dbUser = await prisma.user.findUnique({ where: { id: auth.sub }, include: { units: true } })
    const readerRoles = ['supervisor', 'production_manager', 'factory_manager']
    const ownsUnit = auth.role === 'operator' && dbUser?.units.some((u) => u.id === unitId)
    if (!ownsUnit && !readerRoles.includes(auth.role)) {
      return reply.code(403).send({ code: 'forbidden', message: 'لا تملك صلاحية على هذه الوحدة' })
    }

    const { start, end } = dayBoundsMs(day)
    const events = await prisma.unitEvent.findMany({
      where: { unitId, at: { gte: new Date(start), lt: new Date(end) } },
      orderBy: { at: 'asc' },
    })
    const startEvent = events.find((event) => event.type === 'start')
    const nowMs = Date.now()
    const boundsAnchor = day === sudanDayKey(nowMs) ? nowMs : start

    return {
      ...computeDayState(unit, events, startEvent?.startPhotoUrl ?? null, boundsAnchor),
      departmentId: unit.departmentId,
      segments: buildSegments(events, shiftBounds(boundsAnchor), boundsAnchor),
    }
  })

  app.post('/units/:unitId/start', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })

    const { unitId } = request.params as { unitId: string }
       const authz = await authorizeUnit(auth, unitId, true)
    if (!authz.ok) return reply.code(authz.status).send({ code: authz.code, message: authz.message })

    const nowMs = Date.now()
    const { dayStart, dayEnd } = sudanDayBounds(nowMs)
    const events = await prisma.unitEvent.findMany({
      where: { unitId, at: { gte: new Date(dayStart), lt: new Date(dayEnd) } },
      orderBy: { at: 'asc' },
    })
    const startEvent = events.find((event) => event.type === 'start')
    const { status } = computeDayState(authz.unit, events, startEvent?.startPhotoUrl ?? null, nowMs)

    if (status === 'running') return reply.code(409).send({ code: 'already_running', message: 'الوحدة تعمل بالفعل' })
    if (status === 'fault') return reply.code(409).send({ code: 'fault_open', message: 'يوجد عطل مفتوح على الوحدة' })

    if (status === 'stopped') {
      await prisma.unitEvent.create({ data: { unitId, type: 'resume', at: new Date(nowMs) } })
    } else {
      const body = startUnitSchema.safeParse(request.body)
      if (!body.success || !body.data.photoDataUrl) {
        return reply.code(400).send({ code: 'photo_required', message: 'صورة التشغيل مطلوبة لأول تشغيل في اليوم' })
      }
      await prisma.unitEvent.create({
        data: { unitId, type: 'start', at: new Date(nowMs), startPhotoUrl: body.data.photoDataUrl },
      })
    }

    const freshEvents = await prisma.unitEvent.findMany({
      where: { unitId, at: { gte: new Date(dayStart), lt: new Date(dayEnd) } },
      orderBy: { at: 'asc' },
    })
    const freshStart = freshEvents.find((event) => event.type === 'start')
    return computeDayState(authz.unit, freshEvents, freshStart?.startPhotoUrl ?? null, nowMs)
  })

  app.post('/units/:unitId/stop', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })

    const { unitId } = request.params as { unitId: string }
       const authz = await authorizeUnit(auth, unitId, true)
    if (!authz.ok) return reply.code(authz.status).send({ code: authz.code, message: authz.message })

    const nowMs = Date.now()
    const { dayStart, dayEnd } = sudanDayBounds(nowMs)
    const events = await prisma.unitEvent.findMany({
      where: { unitId, at: { gte: new Date(dayStart), lt: new Date(dayEnd) } },
      orderBy: { at: 'asc' },
    })
    const startEvent = events.find((event) => event.type === 'start')
    const { status } = computeDayState(authz.unit, events, startEvent?.startPhotoUrl ?? null, nowMs)

    if (status !== 'running') {
      return reply.code(409).send({ code: 'not_running', message: 'الوحدة ليست قيد التشغيل' })
    }

    await prisma.unitEvent.create({ data: { unitId, type: 'stop', at: new Date(nowMs) } })

    const freshEvents = await prisma.unitEvent.findMany({
      where: { unitId, at: { gte: new Date(dayStart), lt: new Date(dayEnd) } },
      orderBy: { at: 'asc' },
    })
    return computeDayState(authz.unit, freshEvents, startEvent?.startPhotoUrl ?? null, nowMs)
  })

  app.post('/units/:unitId/faults', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })

    const { unitId } = request.params as { unitId: string }
        const authz = await authorizeUnit(auth, unitId, true)
    if (!authz.ok) return reply.code(authz.status).send({ code: authz.code, message: authz.message })

    const body = reportFaultSchema.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ code: 'invalid_request', message: 'بيانات العطل غير صحيحة' })

    const nowMs = Date.now()
    const { dayStart, dayEnd } = sudanDayBounds(nowMs)
    const events = await prisma.unitEvent.findMany({
      where: { unitId, at: { gte: new Date(dayStart), lt: new Date(dayEnd) } },
      orderBy: { at: 'asc' },
    })
    const startEvent = events.find((event) => event.type === 'start')
    const { status } = computeDayState(authz.unit, events, startEvent?.startPhotoUrl ?? null, nowMs)

    if (status === 'fault') {
      return reply.code(409).send({ code: 'fault_already_open', message: 'يوجد عطل مفتوح بالفعل' })
    }

    const reporter = await prisma.user.findUnique({ where: { id: auth.sub } })
    const description = body.data.description?.trim() || null

    const fault = await prisma.fault.create({
      data: {
        unitId,
        urgent: body.data.urgent,
        description,
        reportedAt: new Date(nowMs),
        reportedByName: reporter?.fullName ?? '—',
        technicians: [],
        log: [{ at: nowMs, text: `${reporter?.fullName ?? '—'} أبلغ عن ${body.data.urgent ? 'عطل عاجل' : 'عطل'}` }],
      },
    })

    await prisma.unitEvent.create({
      data: { unitId, type: 'fault_reported', at: new Date(nowMs), urgent: body.data.urgent, description, faultId: fault.id },
    })

    const freshEvents = await prisma.unitEvent.findMany({
      where: { unitId, at: { gte: new Date(dayStart), lt: new Date(dayEnd) } },
      orderBy: { at: 'asc' },
    })
    return computeDayState(authz.unit, freshEvents, startEvent?.startPhotoUrl ?? null, nowMs)
  })

    app.get('/production/config', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })

    const departments = await prisma.department.findMany({ orderBy: { createdAt: 'asc' } })
    return {
      departments: departments.map((department) => ({
        id: department.id,
        name: department.name,
        active: department.active,
        sizes: sizesForDepartment(department.id),
      })),
    }
  })

  app.get('/faults', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })

    const dbUser = await prisma.user.findUnique({ where: { id: auth.sub }, include: { units: true } })
    const unitIds = dbUser?.units.map((unit) => unit.id) ?? []
    const departmentId = dbUser?.departmentId ?? null

    const faults = await prisma.fault.findMany({ include: { unit: true }, orderBy: { reportedAt: 'desc' } })
    const nowMs = Date.now()

    return faults
      .filter((fault) => faultVisibleTo({ role: auth.role, unitIds, departmentId }, fault))
      .map((fault) => toFaultDto(fault, nowMs))
  })
  
    app.get('/faults/:faultId', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })

    const { faultId } = request.params as { faultId: string }
    const result = await loadVisibleFault(auth, faultId)
    if (!result.ok) return reply.code(result.status).send({ code: result.code, message: result.message })

    return toFaultDto(result.ctx.fault, Date.now())
  })

  app.post('/faults/:faultId/arrive', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })

    const { faultId } = request.params as { faultId: string }
    const result = await loadVisibleFault(auth, faultId)
    if (!result.ok) return reply.code(result.status).send({ code: result.code, message: result.message })
    const { fault, fullName } = result.ctx

    if (fault.closedAt !== null) return reply.code(409).send({ code: 'fault_closed', message: 'هذا العطل مغلق' })
    if (auth.role !== 'technician') {
      return reply.code(403).send({ code: 'forbidden', message: 'تسجيل الوصول للفنيين فقط' })
    }

    const technicians = (fault.technicians as unknown as StoredTechnician[]) ?? []
    if (technicians.some((item) => item.userId === auth.sub)) {
      return reply.code(409).send({ code: 'already_arrived', message: 'سجّلت وصولك بالفعل' })
    }

    const nowMs = Date.now()
    const updatedTechnicians: StoredTechnician[] = [
      ...technicians,
      {
        userId: auth.sub,
        name: fullName,
        arrivedAt: nowMs,
        arrivalConfirmedAt: null,
        confirmedBy: null,
        finishedAt: null,
        intervals: [],
      },
    ]
    const log = (fault.log as unknown as StoredLogEntry[]) ?? []
    const updatedLog: StoredLogEntry[] = [
      ...log,
      { at: nowMs, text: `وصل الفني ${fullName}، وبانتظار التأكيد` },
    ]

    const updated = await prisma.fault.update({
      where: { id: faultId },
      data: { technicians: updatedTechnicians, log: updatedLog },
      include: { unit: true },
    })
    return toFaultDto(updated, nowMs)
  })

  app.post('/faults/:faultId/confirm-arrival', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })

    const { faultId } = request.params as { faultId: string }
    const result = await loadVisibleFault(auth, faultId)
    if (!result.ok) return reply.code(result.status).send({ code: result.code, message: result.message })
    const { fault, fullName, unitIds, departmentId } = result.ctx

    if (fault.closedAt !== null) return reply.code(409).send({ code: 'fault_closed', message: 'هذا العطل مغلق' })
    if (!canConfirmFault(auth.role, unitIds, departmentId, fault)) {
      return reply.code(403).send({ code: 'forbidden', message: 'التأكيد لمشغل الوحدة أو لمشرف القسم فقط' })
    }

    const body = confirmArrivalSchema.safeParse(request.body)
    if (!body.success) {
      return reply.code(400).send({ code: 'invalid_request', message: 'حدد الفني المطلوب تأكيده' })
    }

    const technicians = (fault.technicians as unknown as StoredTechnician[]) ?? []
    const target = technicians.find((item) => item.userId === body.data.technicianId)
    if (!target || target.arrivalConfirmedAt !== null) {
      return reply.code(409).send({ code: 'nothing_to_confirm', message: 'لا يوجد وصول بانتظار التأكيد لهذا الفني' })
    }

    const nowMs = Date.now()
    const updatedTechnicians = technicians.map((item) =>
      item.userId === target.userId
        ? {
            ...item,
            arrivalConfirmedAt: nowMs,
            confirmedBy: fullName,
            intervals: [...item.intervals, { from: nowMs, to: null }],
          }
        : item,
    )
    const log = (fault.log as unknown as StoredLogEntry[]) ?? []
    const updatedLog = [...log, { at: nowMs, text: `أكّد ${fullName} وصول ${target.name}، وبدأت الصيانة` }]

    const updated = await prisma.fault.update({
      where: { id: faultId },
      data: { technicians: updatedTechnicians, log: updatedLog },
      include: { unit: true },
    })
    return toFaultDto(updated, nowMs)
  })

  app.post('/faults/:faultId/finish', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })

    const { faultId } = request.params as { faultId: string }
    const result = await loadVisibleFault(auth, faultId)
    if (!result.ok) return reply.code(result.status).send({ code: result.code, message: result.message })
    const { fault, fullName } = result.ctx

    if (fault.closedAt !== null) return reply.code(409).send({ code: 'fault_closed', message: 'هذا العطل مغلق' })

    const technicians = (fault.technicians as unknown as StoredTechnician[]) ?? []
    const mine = technicians.find((item) => item.userId === auth.sub)
    if (!mine || !mine.intervals.some((interval) => interval.to === null)) {
      return reply.code(409).send({ code: 'not_working', message: 'لا توجد صيانة جارية باسمك' })
    }

    const nowMs = Date.now()
    const updatedTechnicians = technicians.map((item) =>
      item.userId === auth.sub
        ? {
            ...item,
            finishedAt: nowMs,
            intervals: item.intervals.map((interval) =>
              interval.to === null ? { ...interval, to: nowMs } : interval,
            ),
          }
        : item,
    )
    const log = (fault.log as unknown as StoredLogEntry[]) ?? []
    const updatedLog = [...log, { at: nowMs, text: `أنهى ${fullName} الإصلاح، وبانتظار التأكيد` }]

    const updated = await prisma.fault.update({
      where: { id: faultId },
      data: { technicians: updatedTechnicians, log: updatedLog },
      include: { unit: true },
    })
    return toFaultDto(updated, nowMs)
  })

  app.post('/faults/:faultId/confirm-repair', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })

    const { faultId } = request.params as { faultId: string }
    const result = await loadVisibleFault(auth, faultId)
    if (!result.ok) return reply.code(result.status).send({ code: result.code, message: result.message })
    const { fault, fullName, unitIds, departmentId } = result.ctx

    if (fault.closedAt !== null) return reply.code(409).send({ code: 'fault_closed', message: 'هذا العطل مغلق' })
    if (!canConfirmFault(auth.role, unitIds, departmentId, fault)) {
      return reply.code(403).send({ code: 'forbidden', message: 'التأكيد لمشغل الوحدة أو لمشرف القسم فقط' })
    }
    if (deriveStatus(fault) !== 'repair_pending') {
      return reply.code(409).send({ code: 'not_finished', message: 'لم يُعلن أي فني انتهاء الإصلاح بعد' })
    }

    const nowMs = Date.now()
    const technicians = (fault.technicians as unknown as StoredTechnician[]) ?? []
    const updatedTechnicians = technicians.map((item) => ({
      ...item,
      intervals: item.intervals.map((interval) =>
        interval.to === null ? { ...interval, to: nowMs } : interval,
      ),
    }))
    const log = (fault.log as unknown as StoredLogEntry[]) ?? []
    const updatedLog = [...log, { at: nowMs, text: `أكّد ${fullName} الإصلاح، وأُغلق العطل` }]

    const updated = await prisma.fault.update({
      where: { id: faultId },
      data: { closedAt: new Date(nowMs), technicians: updatedTechnicians, log: updatedLog },
      include: { unit: true },
    })

    // يُرجع الوحدة لحالتها الطبيعية لو كانت واقفة بسبب هذا العطل بالذات
    const { dayStart, dayEnd } = sudanDayBounds(nowMs)
    const dayEvents = await prisma.unitEvent.findMany({
      where: { unitId: fault.unitId, at: { gte: new Date(dayStart), lt: new Date(dayEnd) } },
      orderBy: { at: 'asc' },
    })
    const startEvent = dayEvents.find((event) => event.type === 'start')
    const dayState = computeDayState(fault.unit, dayEvents, startEvent?.startPhotoUrl ?? null, nowMs)
    if (dayState.status === 'fault') {
      await prisma.unitEvent.create({ data: { unitId: fault.unitId, type: 'fault_resolved', at: new Date(nowMs) } })
    }

    return toFaultDto(updated, nowMs)
  })

  app.post('/faults/:faultId/reject-repair', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })

    const { faultId } = request.params as { faultId: string }
    const result = await loadVisibleFault(auth, faultId)
    if (!result.ok) return reply.code(result.status).send({ code: result.code, message: result.message })
    const { fault, fullName, unitIds, departmentId } = result.ctx

    if (fault.closedAt !== null) return reply.code(409).send({ code: 'fault_closed', message: 'هذا العطل مغلق' })
    if (!canConfirmFault(auth.role, unitIds, departmentId, fault)) {
      return reply.code(403).send({ code: 'forbidden', message: 'التأكيد لمشغل الوحدة أو لمشرف القسم فقط' })
    }
    if (deriveStatus(fault) !== 'repair_pending') {
      return reply.code(409).send({ code: 'not_finished', message: 'لا يوجد إصلاح بانتظار التأكيد' })
    }

    const nowMs = Date.now()
    const technicians = (fault.technicians as unknown as StoredTechnician[]) ?? []
    const names = technicians
      .filter((item) => item.finishedAt !== null)
      .map((item) => item.name)
      .join('، ')
    const updatedTechnicians = technicians.map((item) =>
      item.finishedAt !== null
        ? { ...item, finishedAt: null, intervals: [...item.intervals, { from: nowMs, to: null }] }
        : item,
    )
    const log = (fault.log as unknown as StoredLogEntry[]) ?? []
    const updatedLog = [...log, { at: nowMs, text: `${fullName}: لم تُصلح. المطلوب من ${names} متابعة الصيانة` }]

    const updated = await prisma.fault.update({
      where: { id: faultId },
      data: { technicians: updatedTechnicians, log: updatedLog },
      include: { unit: true },
    })
    return toFaultDto(updated, nowMs)
  })

    app.get('/production/performance/:from/:to', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })

    const dbUser = await prisma.user.findUnique({ where: { id: auth.sub } })
    const { from, to: toParam } = request.params as { from: string; to: string }
    const today = sudanDayKey(Date.now())

    if (!isDayKey(from) || !isDayKey(toParam) || from > toParam || from > today) {
      return reply.code(400).send({ code: 'invalid_range', message: 'الفترة غير صحيحة' })
    }
    const to = toParam < today ? toParam : today
    if (eachDay(from, to).length > 400) {
      return reply.code(400).send({ code: 'range_too_long', message: 'الفترة أطول من المسموح' })
    }

    const performance = await computePerformance(
      { role: auth.role, departmentId: dbUser?.departmentId ?? null },
      from,
      to,
    )
    if (performance.visibleCount === 0) {
      return reply.code(403).send({ code: 'forbidden', message: 'لا تملك صلاحية على تقارير الإنتاج' })
    }

    return { from, to, overall: performance.overall, departments: performance.departments }
  })

    app.get('/gallery/:from/:to', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })

    const dbUser = await prisma.user.findUnique({ where: { id: auth.sub }, include: { units: true } })
    const { from, to: toParam } = request.params as { from: string; to: string }
    const nowMs = Date.now()
    const today = sudanDayKey(nowMs)

    if (!isDayKey(from) || !isDayKey(toParam) || from > toParam || from > today) {
      return reply.code(400).send({ code: 'invalid_range', message: 'الفترة غير صحيحة' })
    }
    const to = toParam < today ? toParam : today
    const days = eachDay(from, to)
    if (days.length > 31) {
      return reply.code(400).send({ code: 'range_too_long', message: 'اختر فترة لا تزيد على 31 يومًا' })
    }

    let units: { id: string; name: string; departmentId: string }[] = []
    if (auth.role === 'operator') {
      units = dbUser?.units ?? []
    } else if (auth.role === 'supervisor') {
      units = await prisma.unit.findMany({ where: { departmentId: dbUser?.departmentId ?? '__none__' } })
    } else if (auth.role === 'production_manager' || auth.role === 'factory_manager') {
      units = await prisma.unit.findMany()
    }

    const photos: {
      id: string
      unitId: string
      unitName: string
      departmentId: string
      day: string
      takenAt: string
      operatorName: string
      url: string
    }[] = []

    for (const unit of units) {
      const operator = await prisma.user.findFirst({
        where: { role: 'operator', units: { some: { id: unit.id } } },
      })

      for (const day of days) {
        const { start, end } = dayBoundsMs(day)
        const events = await prisma.unitEvent.findMany({
          where: { unitId: unit.id, at: { gte: new Date(start), lt: new Date(end) } },
          orderBy: { at: 'asc' },
        })
        const startEvent = events.find((event) => event.type === 'start')
        if (!startEvent?.startPhotoUrl) continue

        photos.push({
          id: `${unit.id}|${day}`,
          unitId: unit.id,
          unitName: unit.name,
          departmentId: unit.departmentId,
          day,
          takenAt: startEvent.at.toISOString(),
          operatorName: operator?.fullName ?? '—',
          url: startEvent.startPhotoUrl,
        })
      }
    }

    photos.sort((a, b) => b.takenAt.localeCompare(a.takenAt))
    return photos
  })

    app.get('/production/targets/:departmentId', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })

    const dbUser = await prisma.user.findUnique({ where: { id: auth.sub } })
    const { departmentId } = request.params as { departmentId: string }
    const department = await prisma.department.findUnique({ where: { id: departmentId } })
    if (!department) return reply.code(404).send({ code: 'department_not_found', message: 'القسم غير موجود' })

    if (!canReadDepartment(auth.role, dbUser?.departmentId ?? null, department.id)) {
      return reply.code(403).send({ code: 'forbidden', message: 'لا تملك صلاحية على أهداف هذا القسم' })
    }

    return targetsDto(department.id, Date.now())
  })

  app.put('/production/targets/:departmentId', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })

    const dbUser = await prisma.user.findUnique({ where: { id: auth.sub } })
    const { departmentId } = request.params as { departmentId: string }
    const department = await prisma.department.findUnique({ where: { id: departmentId } })
    if (!department) return reply.code(404).send({ code: 'department_not_found', message: 'القسم غير موجود' })

    if (auth.role !== 'production_manager') {
      return reply.code(403).send({ code: 'forbidden', message: 'تحديد الأهداف لمدير الإنتاج فقط' })
    }
    if (!department.active) {
      return reply.code(400).send({ code: 'department_inactive', message: 'هذا القسم غير مفعّل بعد' })
    }

    const body = saveTargetsSchema.safeParse(request.body)
    if (!body.success) {
      return reply.code(400).send({ code: 'invalid_request', message: 'الكميات غير صحيحة' })
    }

    const nowMs = Date.now()
    const today = sudanDayKey(nowMs)
    if (!isDayKey(body.data.effectiveFrom) || body.data.effectiveFrom < today) {
      return reply.code(400).send({ code: 'invalid_day', message: 'يبدأ الهدف من اليوم أو بعده' })
    }

    await prisma.productionTarget.create({
      data: {
        departmentId: department.id,
        effectiveFrom: body.data.effectiveFrom,
        quantities: body.data.quantities,
        setByName: dbUser?.fullName ?? '—',
        setAt: new Date(nowMs),
      },
    })

    return targetsDto(department.id, nowMs)
  })

    app.get('/admin/users', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })
    if (!managementRoles.includes(auth.role)) {
      return reply.code(403).send({ code: 'forbidden', message: 'لوحة الإدارة للمدراء فقط' })
    }

    const users = await prisma.user.findMany({ include: { units: true }, orderBy: { createdAt: 'asc' } })
    return users.map(toAdminUser)
  })

  app.post('/admin/users', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })
    if (!managementRoles.includes(auth.role)) {
      return reply.code(403).send({ code: 'forbidden', message: 'لوحة الإدارة للمدراء فقط' })
    }

    const body = createUserBodySchema.safeParse(request.body)
    if (!body.success) {
      return reply.code(400).send({
        code: 'invalid_request',
        message: 'تحقق من البيانات: الاسم، واسم مستخدم بحروف إنجليزية (3 أحرف فأكثر)، وكلمة سر 8 أحرف فأكثر',
      })
    }
    const input = body.data

    if (!canManageRole(auth.role, input.role)) {
      return reply.code(403).send({ code: 'forbidden', message: 'لا تملك صلاحية إنشاء هذا الدور' })
    }

    const existing = await prisma.user.findUnique({ where: { username: input.username } })
    if (existing) {
      return reply.code(409).send({ code: 'username_taken', message: 'اسم المستخدم مستخدم من قبل' })
    }

    const assignment = await normalizeAssignment(input.role, input.departmentId, input.unitIds)
    if (!assignment.ok) {
      return reply.code(400).send({ code: assignment.code, message: assignment.message })
    }

    const passwordHash = await hash(input.password)
    const created = await prisma.user.create({
      data: {
        username: input.username,
        passwordHash,
        fullName: input.fullName,
        role: input.role,
        departmentId: assignment.departmentId,
        mustChangePassword: true,
        active: true,
      },
    })
    await applyUnitAssignment(created.id, assignment.unitIds)

    const withUnits = await prisma.user.findUnique({ where: { id: created.id }, include: { units: true } })
    return toAdminUser(withUnits!)
  })

  app.put('/admin/users/:userId', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })
    if (!managementRoles.includes(auth.role)) {
      return reply.code(403).send({ code: 'forbidden', message: 'لوحة الإدارة للمدراء فقط' })
    }

    const { userId } = request.params as { userId: string }
    const target = await prisma.user.findUnique({ where: { id: userId } })
    if (!target) return reply.code(404).send({ code: 'user_not_found', message: 'المستخدم غير موجود' })

    const body = updateUserBodySchema.safeParse(request.body)
    if (!body.success) {
      return reply.code(400).send({ code: 'invalid_request', message: 'تحقق من البيانات المدخلة' })
    }
    const input = body.data

    if (!canManageRole(auth.role, target.role) || !canManageRole(auth.role, input.role)) {
      return reply.code(403).send({ code: 'forbidden', message: 'لا تملك صلاحية تعديل هذا المستخدم' })
    }
    if (target.id === auth.sub && (input.role !== target.role || !input.active)) {
      return reply.code(400).send({ code: 'self_change', message: 'لا يمكنك تغيير دورك أو تعطيل حسابك' })
    }

    const activeFactoryManagers = await prisma.user.count({ where: { role: 'factory_manager', active: true } })
    if (
      target.role === 'factory_manager' &&
      (input.role !== 'factory_manager' || !input.active) &&
      activeFactoryManagers <= 1
    ) {
      return reply.code(400).send({ code: 'last_manager', message: 'يجب أن يبقى مدير مصنع فعّال واحد على الأقل' })
    }

    const assignment = await normalizeAssignment(input.role, input.departmentId, input.unitIds)
    if (!assignment.ok) {
      return reply.code(400).send({ code: assignment.code, message: assignment.message })
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        fullName: input.fullName,
        role: input.role,
        departmentId: assignment.departmentId,
        active: input.active,
      },
    })
    await applyUnitAssignment(userId, assignment.unitIds)

    const updated = await prisma.user.findUnique({ where: { id: userId }, include: { units: true } })
    return toAdminUser(updated!)
  })

  app.post('/admin/users/:userId/reset-password', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })
    if (!managementRoles.includes(auth.role)) {
      return reply.code(403).send({ code: 'forbidden', message: 'لوحة الإدارة للمدراء فقط' })
    }

    const { userId } = request.params as { userId: string }
    const target = await prisma.user.findUnique({ where: { id: userId } })
    if (!target) return reply.code(404).send({ code: 'user_not_found', message: 'المستخدم غير موجود' })
    if (!canManageRole(auth.role, target.role)) {
      return reply.code(403).send({ code: 'forbidden', message: 'لا تملك صلاحية على هذا المستخدم' })
    }

    const body = resetPasswordBodySchema.safeParse(request.body)
    if (!body.success) {
      return reply.code(400).send({ code: 'invalid_request', message: 'كلمة السر المؤقتة 8 أحرف على الأقل' })
    }

    const passwordHash = await hash(body.data.password)
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { passwordHash, mustChangePassword: true },
      include: { units: true },
    })
    return toAdminUser(updated)
  })

  app.get('/admin/units', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })
    if (!managementRoles.includes(auth.role)) {
      return reply.code(403).send({ code: 'forbidden', message: 'لوحة الإدارة للمدراء فقط' })
    }

    const units = await prisma.unit.findMany({ include: { operators: true }, orderBy: { createdAt: 'asc' } })
    return units.map((unit) => {
      const operator = unit.operators.find((item) => item.role === 'operator') ?? null
      return toAdminUnit(unit, operator)
    })
  })

    app.post('/admin/units', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })
    if (!managementRoles.includes(auth.role)) {
      return reply.code(403).send({ code: 'forbidden', message: 'لوحة الإدارة للمدراء فقط' })
    }

    const body = createUnitBodySchema.safeParse(request.body)
    if (!body.success) {
      return reply.code(400).send({ code: 'invalid_request', message: 'تحقق من بيانات الوحدة' })
    }
    const input = body.data

    const department = await prisma.department.findFirst({ where: { id: input.departmentId, active: true } })
    if (!department) {
      return reply.code(400).send({ code: 'invalid_department', message: 'اختر قسمًا مفعّلًا' })
    }

    const duplicate = await prisma.unit.findFirst({
      where: { departmentId: department.id, name: input.name },
    })
    if (duplicate) {
      return reply.code(409).send({ code: 'unit_exists', message: 'توجد وحدة بنفس الاسم في هذا القسم' })
    }

  const created = await prisma.unit.create({
  data: {
    id: `${department.id}-${Date.now().toString(36)}`,
    name: input.name,
    departmentId: department.id,
    photoHint: input.photoHint || `صوّر شاشة تشغيل ${input.name} وهي تعمل`,
  },
})

    const assignment = await assignOperator(created.id, department.id, input.operatorId)
    if (!assignment.ok) {
      return reply.code(400).send({ code: assignment.code, message: assignment.message })
    }

    const withOperators = await prisma.unit.findUnique({ where: { id: created.id }, include: { operators: true } })
    const operator = withOperators!.operators.find((item) => item.role === 'operator') ?? null
    return toAdminUnit(withOperators!, operator)
  })

  app.put('/admin/units/:unitId', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })
    if (!managementRoles.includes(auth.role)) {
      return reply.code(403).send({ code: 'forbidden', message: 'لوحة الإدارة للمدراء فقط' })
    }

    const { unitId } = request.params as { unitId: string }
    const unit = await prisma.unit.findUnique({ where: { id: unitId } })
    if (!unit) return reply.code(404).send({ code: 'unit_not_found', message: 'الوحدة غير موجودة' })

    const body = updateUnitBodySchema.safeParse(request.body)
    if (!body.success) {
      return reply.code(400).send({ code: 'invalid_request', message: 'تحقق من بيانات الوحدة' })
    }
    const input = body.data

    const assignment = await assignOperator(unit.id, unit.departmentId, input.operatorId)
    if (!assignment.ok) {
      return reply.code(400).send({ code: assignment.code, message: assignment.message })
    }

    const updated = await prisma.unit.update({
      where: { id: unitId },
      data: { name: input.name, photoHint: input.photoHint || unit.photoHint },
      include: { operators: true },
    })
    const operator = updated.operators.find((item) => item.role === 'operator') ?? null
    return toAdminUnit(updated, operator)
  })

    app.get('/reports/production/:from/:to', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })
    if (auth.role !== 'production_manager' && auth.role !== 'factory_manager') {
      return reply.code(403).send({ code: 'forbidden', message: 'لا تملك صلاحية على هذا التقرير' })
    }

    const { from, to: toParam } = request.params as { from: string; to: string }
    const nowMs = Date.now()
    const today = sudanDayKey(nowMs)

    if (!isDayKey(from) || !isDayKey(toParam) || from > toParam || from > today) {
      return reply.code(400).send({ code: 'invalid_range', message: 'الفترة غير صحيحة' })
    }
    const to = toParam < today ? toParam : today
    if (eachDay(from, to).length > 400) {
      return reply.code(400).send({ code: 'range_too_long', message: 'الفترة أطول من المسموح' })
    }

    return buildProductionReport(from, to, nowMs)
  })

  app.get('/reports/operations/:month', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })
    if (auth.role !== 'factory_manager') {
      return reply.code(403).send({ code: 'forbidden', message: 'لا تملك صلاحية على هذا التقرير' })
    }

    const { month } = request.params as { month: string }
    const nowMs = Date.now()
    const today = sudanDayKey(nowMs)
    const bounds = monthBounds(month)
    if (!bounds || bounds.from > today) {
      return reply.code(400).send({ code: 'invalid_month', message: 'الشهر غير صحيح' })
    }
    const to = bounds.to < today ? bounds.to : today

    return buildOperationsReport(month, bounds.from, to, nowMs)
  })

    app.get('/notifications', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })

    const items = await prisma.notification.findMany({
      where: { userId: auth.sub },
      orderBy: { at: 'desc' },
      take: 100,
    })
    const unreadCount = await prisma.notification.count({ where: { userId: auth.sub, read: false } })

    return {
      items: items.map((item) => ({
        id: item.id,
        kind: item.kind,
        title: item.title,
        body: item.body,
        at: item.at.toISOString(),
        read: item.read,
        link: item.link,
      })),
      unreadCount,
    }
  })

  app.get('/notifications/unread-count', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })

    const unreadCount = await prisma.notification.count({ where: { userId: auth.sub, read: false } })
    return { unreadCount }
  })

  app.post('/notifications/:notificationId/read', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })

    const { notificationId } = request.params as { notificationId: string }
    await prisma.notification.updateMany({
      where: { id: notificationId, userId: auth.sub },
      data: { read: true },
    })
    const unreadCount = await prisma.notification.count({ where: { userId: auth.sub, read: false } })
    return { unreadCount }
  })

  app.post('/notifications/read-all', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })

    await prisma.notification.updateMany({ where: { userId: auth.sub, read: false }, data: { read: true } })
    return { unreadCount: 0 }
  })

  app.get('/notification-settings', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })

    return settingsFor(auth.sub, auth.role)
  })

  app.put('/notification-settings/:kind', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })

    const { kind } = request.params as { kind: string }
    const entry = notificationCatalog.find((item) => item.kind === kind && item.roles.includes(auth.role))
    if (!entry) return reply.code(404).send({ code: 'unknown_category', message: 'فئة الإشعارات غير موجودة' })
    if (entry.mandatory) {
      return reply.code(400).send({ code: 'mandatory_notification', message: 'هذا الإشعار إلزامي ولا يمكن إيقافه' })
    }

    const body = updateNotificationSettingSchema.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ code: 'invalid_request', message: 'بيانات غير صحيحة' })

    await prisma.notificationPreference.upsert({
      where: { userId_kind: { userId: auth.sub, kind } },
      update: { enabled: body.data.enabled },
      create: { userId: auth.sub, kind, enabled: body.data.enabled },
    })

    return settingsFor(auth.sub, auth.role)
  })

    app.get('/admin/settings', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })
    if (auth.role !== 'factory_manager') {
      return reply.code(403).send({ code: 'forbidden', message: 'هذه الشاشة لمدير المصنع فقط' })
    }
    return currentSettings()
  })

  app.put('/admin/settings', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })
    if (auth.role !== 'factory_manager') {
      return reply.code(403).send({ code: 'forbidden', message: 'هذه الشاشة لمدير المصنع فقط' })
    }

    const body = systemSettingsBodySchema.safeParse(request.body)
    if (!body.success) {
      return reply.code(400).send({
        code: 'invalid_settings',
        message: 'تحقق من القيم: نهاية الشيفت بعد بدايته، والمدد بين 1 و240 دقيقة',
      })
    }

    await prisma.systemSettings.upsert({
      where: { id: 'singleton' },
      update: body.data,
      create: { id: 'singleton', ...body.data },
    })
    setCurrentSettings(body.data)

    return body.data
  })

  app.get('/admin/activity', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })
    if (auth.role !== 'factory_manager') {
      return reply.code(403).send({ code: 'forbidden', message: 'هذه الشاشة لمدير المصنع فقط' })
    }
    return listActivity()
  })

    app.get('/production/entries/:departmentId/:day', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })

    const dbUser = await prisma.user.findUnique({ where: { id: auth.sub } })
    const { departmentId, day } = request.params as { departmentId: string; day: string }
    const department = await prisma.department.findUnique({ where: { id: departmentId } })
    if (!department) return reply.code(404).send({ code: 'department_not_found', message: 'القسم غير موجود' })

    if (!canReadDepartment(auth.role, dbUser?.departmentId ?? null, department.id)) {
      return reply.code(403).send({ code: 'forbidden', message: 'لا تملك صلاحية على إنتاج هذا القسم' })
    }
    if (!isDayKey(day)) return reply.code(400).send({ code: 'invalid_day', message: 'التاريخ غير صحيح' })

    return entryDto(department.id, day)
  })

  app.put('/production/entries/:departmentId/:day', async (request, reply) => {
    const auth = (await request.jwtVerify().catch(() => null)) as { sub: string; role: string } | null
    if (!auth) return reply.code(401).send({ code: 'unauthorized', message: 'الرجاء تسجيل الدخول' })

    const dbUser = await prisma.user.findUnique({ where: { id: auth.sub } })
    const { departmentId, day } = request.params as { departmentId: string; day: string }
    const department = await prisma.department.findUnique({ where: { id: departmentId } })
    if (!department) return reply.code(404).send({ code: 'department_not_found', message: 'القسم غير موجود' })

    const nowMs = Date.now()
    const today = sudanDayKey(nowMs)

    if (auth.role !== 'supervisor' || dbUser?.departmentId !== department.id) {
      return reply.code(403).send({ code: 'forbidden', message: 'إدخال الإنتاج لمشرف القسم فقط' })
    }
    if (!isDayKey(day) || day > today || day < addDays(today, -MAX_ENTRY_AGE_DAYS)) {
      return reply.code(400).send({ code: 'invalid_day', message: 'يمكن إدخال الإنتاج لآخر 7 أيام فقط' })
    }

    const body = saveEntryBodySchema.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ code: 'invalid_request', message: 'الكميات غير صحيحة' })

    const result = await saveEntry(department.id, day, body.data.quantities, dbUser?.fullName ?? '—', nowMs)

    await notify(
      await allManagers(),
      {
        kind: 'production_added',
        title: `إدخال إنتاج ${department.name}`,
        body: `${dbUser?.fullName ?? '—'} أدخل إنتاج يوم ${day}`,
        link: '/production',
      },
      nowMs,
      auth.sub,
    )

    return result
  })

  const port = Number(process.env.PORT ?? 4000)
  setInterval(() => {
  runEscalations(Date.now()).catch((error) => app.log.error(error, 'escalation run failed'))
}, 60_000)
  await loadSettingsIntoCache()
  await app.listen({ port, host: '0.0.0.0' })
}

main().catch((error) => {
  app.log.error(error)
  process.exit(1)
})