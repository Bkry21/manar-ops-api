import { cp, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const source = resolve(import.meta.dirname, '../../manar-ops/src/api/contracts')
const target = resolve(import.meta.dirname, '../src/contracts')

await mkdir(target, { recursive: true })
await cp(source, target, { recursive: true })
console.log(`تم نسخ العقود من ${source}`)