import { DateTime } from 'luxon';
import type { MarketSession } from '../domain.js';
export const ZONE = 'Asia/Kolkata';
export const MINUTE = 60000;
export function dayKey(ts: number): string {
  return DateTime.fromMillis(ts, { zone: ZONE }).toFormat('yyyy-MM-dd');
}
export function minuteOfDay(ts: number): number {
  const d = DateTime.fromMillis(ts, { zone: ZONE });
  return d.hour * 60 + d.minute;
}
export function atIST(day: string, time: string): number {
  const d = DateTime.fromISO(`${day}T${time}`, { zone: ZONE });
  if (!d.isValid) throw new Error('Invalid date/time');
  return d.toMillis();
}
export function addDays(day: string, count: number): string {
  return DateTime.fromISO(day, { zone: ZONE }).plus({ days: count }).toFormat('yyyy-MM-dd');
}
export function daysUntil(day: string, expiry: string): number {
  return DateTime.fromISO(expiry, { zone: ZONE }).diff(DateTime.fromISO(day, { zone: ZONE }), 'days').days;
}
export function demoSession(day: string): MarketSession {
  return {
    id: day,
    day,
    open: atIST(day, '09:15'),
    close: atIST(day, '15:30'),
    trading: DateTime.fromISO(day, { zone: ZONE }).weekday <= 5,
    verified: false,
    source: 'SYNTHETIC_WEEKDAY_CALENDAR',
    receivedAt: atIST(day, '08:45'),
  };
}
export interface ScheduledTask {
  id: string;
  kind: 'PREPARE' | 'PREMARKET' | 'INITIAL' | 'REEVALUATION' | 'DEEP' | 'CLOSE';
  at: number;
}
export function sessionSchedule(session: MarketSession): ScheduledTask[] {
  if (!session.trading) return [];
  const task = (kind: ScheduledTask['kind'], at: number) => ({
    id: `${session.day}:${kind}:${at}`,
    kind,
    at,
  });
  const out = [task('PREPARE', session.open - 30 * MINUTE), task('PREMARKET', session.open - 15 * MINUTE)];
  for (let at = session.open + 5 * MINUTE, n = 0; at < session.close; at += 15 * MINUTE, n++)
    out.push(task(n === 0 ? 'INITIAL' : n % 2 === 0 ? 'DEEP' : 'REEVALUATION', at));
  out.push(task('CLOSE', session.close));
  return out;
}
export function nextAnalysis(session: MarketSession, now: number): number | null {
  return (
    sessionSchedule(session).find((t) => ['INITIAL', 'REEVALUATION', 'DEEP'].includes(t.kind) && t.at > now)
      ?.at ?? null
  );
}
export function fresh(sourceTs: number, receivedAt: number, now: number, maxAge: number): boolean {
  return (
    Number.isFinite(sourceTs) &&
    Number.isFinite(receivedAt) &&
    sourceTs > 0 &&
    sourceTs <= now &&
    receivedAt <= now &&
    receivedAt >= sourceTs - 2000 &&
    now - sourceTs <= maxAge &&
    now - receivedAt <= maxAge
  );
}
