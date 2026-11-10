import { cert, getApps, initializeApp } from 'firebase-admin/app'
import { getMessaging } from 'firebase-admin/messaging'

function ensureInitialized(): boolean {
  if (getApps().length > 0) return true
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64
  if (!encoded) return false

  const serviceAccount = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
  initializeApp({ credential: cert(serviceAccount) })
  return true
}

export async function sendPush(token: string, title: string, body: string, link: string): Promise<void> {
  if (!ensureInitialized()) return
  try {
    await getMessaging().send({ token, notification: { title, body }, data: { link } })
  } catch (error) {
    console.error('push send failed', error)
  }
}