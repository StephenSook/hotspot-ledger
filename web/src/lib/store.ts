// Small persistent state for one browser (decisions, STAR log). Every access is guarded:
// storage can be missing in private windows, previews or with blocked site data.
import { useCallback, useState } from 'react'

const PREFIX = 'hotspot-ledger:'

export function readStore<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(PREFIX + key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export function writeStore<T>(key: string, value: T): void {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    /* storage unavailable: the page still works, it just will not remember */
  }
}

export function useStored<T>(key: string, fallback: T): [T, (v: T | ((p: T) => T)) => void] {
  // Keys are stable for a page's lifetime (the week key changes only across sessions), so read once.
  const [value, setValue] = useState<T>(() => readStore(key, fallback))
  const set = useCallback(
    (v: T | ((p: T) => T)) =>
      setValue((prev) => {
        const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v
        writeStore(key, next)
        return next
      }),
    [key],
  )
  return [value, set]
}
