/**
 * App events in Zova (#179). The collector emits `report_stored`; the processor reads the pending ones in order,
 * and after a restart picks up where it stopped.
 *
 * Delivery is at least once: a consumer that crashes after doing its work but before `finish` sees the event
 * again. The processor's work is idempotent (#166), so the result is the same as processing it once. `finish`
 * marks the event handled and records the outcome event in one Zova transaction, so an event is never marked
 * handled without its outcome, or the other way round.
 */
import type { Store } from "./zova.ts";

export type EventType = "report_stored" | "report_processed" | "report_failed";

export interface AppEvent {
  id: number;
  type: EventType;
  subject: string;
  payload: Record<string, unknown>;
  created_at: string;
  handled_at: string | null;
}

/** Outcome of handling a `report_stored` event. */
export type Outcome =
  | { type: "report_processed"; payload?: Record<string, unknown> }
  | { type: "report_failed"; reason: string; payload?: Record<string, unknown> };

const now = () => new Date().toISOString();

function toEvent(row: Record<string, unknown>): AppEvent {
  return {
    id: Number(row.id),
    type: row.type as EventType,
    subject: String(row.subject),
    payload: JSON.parse(String(row.payload)),
    created_at: String(row.created_at),
    handled_at: row.handled_at === null ? null : String(row.handled_at),
  };
}

/**
 * Add an event; returns its id. Run it in the same transaction as the write it describes.
 * `handled: true` records an event nobody needs to act on (an outcome), so it never shows as pending.
 */
export function emit(
  store: Store,
  type: EventType,
  subject: string,
  payload: Record<string, unknown> = {},
  { handled = false }: { handled?: boolean } = {},
): number {
  const at = now();
  store.run("INSERT INTO events (type, subject, payload, created_at, handled_at) VALUES (?1, ?2, ?3, ?4, ?5)", [
    type,
    subject,
    JSON.stringify(payload),
    at,
    handled ? at : null,
  ]);
  return Number(store.query("SELECT last_insert_rowid() AS id")[0]?.id);
}

/** Events of `type` not yet handled, oldest first. */
export function pending(store: Store, type: EventType, limit = 100): AppEvent[] {
  return store
    .query("SELECT * FROM events WHERE type = ?1 AND handled_at IS NULL ORDER BY id LIMIT ?2", [type, limit])
    .map(toEvent);
}

export function getEvent(store: Store, id: number): AppEvent | null {
  const row = store.query("SELECT * FROM events WHERE id = ?1", [id])[0];
  return row ? toEvent(row) : null;
}

/** Events about one subject, oldest first: the history of one stored file. */
export function history(store: Store, subject: string): AppEvent[] {
  return store.query("SELECT * FROM events WHERE subject = ?1 ORDER BY id", [subject]).map(toEvent);
}

export class EventStateError extends Error {
  override name = "EventStateError";
}

/**
 * Mark `event` handled and record its outcome as a new event about the same subject, in one transaction.
 * Returns the outcome event's id. Refuses an event that is already handled.
 */
export function finish(store: Store, event: AppEvent, outcome: Outcome): number {
  return store.transaction((s) => {
    const changed = s.run("UPDATE events SET handled_at = ?1 WHERE id = ?2 AND handled_at IS NULL", [now(), event.id]);
    if (changed !== 1) throw new EventStateError(`event ${event.id} is already handled or does not exist`);
    const payload =
      outcome.type === "report_failed"
        ? { ...outcome.payload, reason: outcome.reason, event: event.id }
        : { ...outcome.payload, event: event.id };
    return emit(s, outcome.type, event.subject, payload, { handled: true });
  });
}
