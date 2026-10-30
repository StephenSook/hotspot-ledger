import { Children, useEffect, useState, type CSSProperties, type ReactNode } from 'react'

import { ROUTES, type Route } from '../lib/routes'

export function Plus({ color = 'currentColor' }: { color?: string }) {
  return (
    <svg className="plus" viewBox="0 0 6 7" aria-hidden="true">
      <rect x="2.5" y="0" width="1" height="7" fill={color} />
      <rect x="0" y="3" width="6" height="1" fill={color} />
    </svg>
  )
}

export function Corners() {
  return (
    <span className="corners" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  )
}

export function Frame({ children, className = '', label, style }: { children: ReactNode; className?: string; label?: string; style?: CSSProperties }) {
  return (
    <section className={`frame ${className}`} style={style} aria-label={label}>
      <Corners />
      {children}
    </section>
  )
}

/** Staggered blur-in, one child at a time. Static when the user prefers reduced motion (CSS). */
export function Reveal({ children, delay = 0, className = '' }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <div className={`reveal ${className}`}>
      {Children.toArray(children).map((child, i) => (
        <div key={i} style={{ '--i': i, '--d': `${delay}ms` } as CSSProperties}>
          {child}
        </div>
      ))}
    </div>
  )
}

function useMabletonTime() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(t)
  }, [])
  const time = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false })
  const hour = Number(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }))
  const zone = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' }).split(' ').pop()
  return { time, zone, night: hour < 7 || hour >= 19 }
}

export function BottomBar({ route }: { route: Route | null }) {
  const { time, zone, night } = useMabletonTime()
  return (
    <footer className="bar">
      <nav aria-label="Sections">
        {ROUTES.map((r) => (
          <a key={r.id} href={`#/${r.id}`} aria-current={r.id === route ? 'page' : undefined}>
            {r.label}
            <Plus />
          </a>
        ))}
      </nav>
      <div className="clock" aria-hidden="true">
        {night ? (
          <svg width="9" height="9" viewBox="0 0 9 9"><path d="M6.5 0.8A4 4 0 1 0 8.2 6.5 3.2 3.2 0 0 1 6.5 0.8Z" fill="currentColor" /></svg>
        ) : (
          <svg width="9" height="9" viewBox="0 0 9 9"><circle cx="4.5" cy="4.5" r="2" fill="currentColor" /><g stroke="currentColor" strokeWidth="1"><path d="M4.5 0v1.3M4.5 7.7V9M0 4.5h1.3M7.7 4.5H9" /></g></svg>
        )}
        <span>Mableton {zone}</span>
        <span className="mark" />
        <span>{time}</span>
      </div>
      <a className="chip" href="#/evidence">
        Sources <Plus />
      </a>
    </footer>
  )
}

export function Stat({ value, label, red = false }: { value: ReactNode; label: ReactNode; red?: boolean }) {
  return (
    <div className="stat">
      <span className={`v${red ? ' red' : ''}`}>{value}</span>
      <span className="k">{label}</span>
    </div>
  )
}

export function HBar({ label, value, max, text, red = false }: { label: string; value: number; max: number; text: string; red?: boolean }) {
  const w = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0
  return (
    <div className="hbar">
      <span className="lbl">{label}</span>
      <span className="track" aria-hidden="true"><span className={`fill${red ? ' red' : ''}`} style={{ width: `${w}%` }} /></span>
      <span className="val">{text}</span>
    </div>
  )
}
