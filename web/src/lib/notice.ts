import { useEffect, useState } from 'react'
import { verifyNoticeToken, type VerifyResult } from '../../../api/_lib/notice'

export { NOTICE_PUBLIC_KEY, wordingDigest } from '../../../api/_lib/notice'

/** Where a resident reports dumping: the city's own Code Enforcement page (Submit a Complaint). */
export const REPORT_URL = 'https://www.mableton.gov/1201/Code-Enforcement-Department'
/** Code Enforcement's phone, as listed under Contact Us on that page (read Oct 30, 2026). */
export const REPORT_PHONE = { label: '404-590-2511', tel: '+14045902511' }

export type NoticeState = { status: 'checking' } | VerifyResult

/** Checks a notice token in this browser. Nothing is sent anywhere. */
export function useVerifiedNotice(token: string): NoticeState {
  // Keyed by token, so a new link reads as "checking" until its own result arrives.
  const [done, setDone] = useState<{ token: string; result: VerifyResult } | null>(null)
  useEffect(() => {
    let live = true
    verifyNoticeToken(token)
      .then((result) => { if (live) setDone({ token, result }) })
      .catch(() => { if (live) setDone({ token, result: { status: 'unsupported' } }) })
    return () => { live = false }
  }, [token])
  return done && done.token === token ? done.result : { status: 'checking' }
}

export function issuedLabel(date: string, lang: 'en' | 'es'): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  })
}

export function verifyUrl(token: string): string {
  return `${window.location.origin}/#/v/${token}`
}
