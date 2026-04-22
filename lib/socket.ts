"use client";

import { io, Socket } from "socket.io-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ConnectionStatus = "connected" | "connecting" | "disconnected";

type EventName = string;
type EventHandler = (...args: unknown[]) => void;

type StatusListener = (status: ConnectionStatus) => void;

// ─── Module-level singleton state ─────────────────────────────────────────────
//
// These variables live at module scope, outside any React component. Module
// scope persists for the entire browser session, surviving React StrictMode's
// double-mount/unmount cycle.
//
// React StrictMode (dev only) mounts every component twice in quick succession
// to surface side-effects. If you create a socket inside useEffect without a
// module-level guard:
//
//   Mount 1  → useEffect fires  → socket A created, connects
//   Unmount  → cleanup fires    → socket A disconnected
//   Mount 2  → useEffect fires  → socket B created, connects (duplicate)
//
// Keeping the socket at module scope means both mount cycles share the same
// instance. The cleanup function decrements a ref-count; only the last
// consumer calling disconnect() actually closes the connection.

let socket: Socket | null = null;
let refCount = 0;

// All active event subscriptions, grouped by event name.
// Re-registered on every reconnect so listeners are never silently lost.
const subscriptions = new Map<EventName, Set<EventHandler>>();

// All functions that want to be notified of connection status changes.
const statusListeners = new Set<StatusListener>();

let currentStatus: ConnectionStatus = "disconnected";

// ─── Internal helpers ─────────────────────────────────────────────────────────

function setStatus(next: ConnectionStatus): void {
  if (next === currentStatus) return;
  currentStatus = next;
  for (const listener of statusListeners) {
    listener(next);
  }
}

/**
 * Registers all entries in `subscriptions` on the raw socket.
 * Called once on initial connect and again after every reconnect.
 * Without this, a reconnect creates a new underlying transport while the old
 * socket.on() bindings are gone — the app receives no events until full reload.
 */
function reattachSubscriptions(s: Socket): void {
  for (const [event, handlers] of subscriptions.entries()) {
    for (const handler of handlers) {
      s.on(event, handler);
    }
  }
}

function attachCoreListeners(s: Socket): void {
  s.on("connect", () => {
    setStatus("connected");
    // Re-register application subscriptions after each reconnect.
    // socket.io-client clears all listeners on transport teardown
    // but does NOT re-run the original socket.on() calls.
    reattachSubscriptions(s);
  });

  s.on("disconnect", (reason) => {
    // "io server disconnect" means the server explicitly kicked this client —
    // socket.io will NOT auto-reconnect in that case, so we reconnect manually.
    if (reason === "io server disconnect") {
      s.connect();
    }
    setStatus("disconnected");
  });

  s.on("connect_error", () => {
    setStatus("connecting"); // still trying — exponential backoff in progress
  });

  s.io.on("reconnect_attempt", () => {
    setStatus("connecting");
  });

  s.io.on("reconnect", () => {
    setStatus("connected");
  });

  s.io.on("reconnect_failed", () => {
    // All retries exhausted (only fires if reconnectionAttempts is finite)
    setStatus("disconnected");
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialises (or reuses) the singleton socket connection.
 * Call once from the top-level component that needs real-time data.
 * Returns a teardown function — pass it to the useEffect cleanup.
 *
 * @example
 * useEffect(() => {
 *   const teardown = initSocket();
 *   return teardown;
 * }, []);
 */
export function initSocket(): () => void {
  if (typeof window === "undefined") {
    // SSR guard — socket.io-client is browser-only
    return () => {};
  }

  refCount += 1;

  if (!socket) {
    const url = process.env.NEXT_PUBLIC_SOCKET_URL ?? "";

    socket = io(url, {
      // ── Transport ──────────────────────────────────────────────────────
      // Start with WebSocket directly. Falling back to polling adds a
      // round-trip on every connection and is only needed for proxies that
      // block WebSockets.
      transports: ["websocket"],

      // ── Reconnection — exponential backoff ────────────────────────────
      // socket.io computes the next delay as:
      //   min(reconnectionDelay * reconnectionDelayMax^attempt, maxDelay)
      // Here: 1s, 2s, 4s, 8s … capped at 30s
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1_000,        // initial delay (ms)
      reconnectionDelayMax: 30_000,    // maximum delay (ms)
      randomizationFactor: 0.3,        // ±30% jitter to avoid thundering herd

      // ── Timeout ───────────────────────────────────────────────────────
      timeout: 10_000,

      // ── Auth ──────────────────────────────────────────────────────────
      // Extend here if the server expects a token:
      // auth: { token: getAuthToken() },
    });

    setStatus("connecting");
    attachCoreListeners(socket);
  }

  // Return cleanup function for useEffect
  return () => {
    refCount -= 1;
    if (refCount <= 0) {
      socket?.disconnect();
      socket = null;
      refCount = 0;
      subscriptions.clear();
      statusListeners.clear();
      setStatus("disconnected");
    }
  };
}

/**
 * Subscribes to a socket event. Safe to call before the socket connects —
 * the handler is stored and re-attached on connect and every subsequent
 * reconnect.
 *
 * Returns an unsubscribe function.
 *
 * @example
 * const off = socketOn('new_acquisition', (data) => { ... });
 * return off; // inside useEffect cleanup
 */
export function socketOn(event: EventName, handler: EventHandler): () => void {
  if (!subscriptions.has(event)) {
    subscriptions.set(event, new Set());
  }
  subscriptions.get(event)!.add(handler);

  // If the socket is already live, bind immediately so we don't miss events
  // fired before the next reconnect cycle
  socket?.on(event, handler);

  return () => socketOff(event, handler);
}

/**
 * Removes a specific handler for an event.
 */
export function socketOff(event: EventName, handler: EventHandler): void {
  subscriptions.get(event)?.delete(handler);
  socket?.off(event, handler);
}

/**
 * Emits an event to the server.
 */
export function socketEmit(event: EventName, ...args: unknown[]): void {
  if (!socket?.connected) {
    console.warn(`[socket] emit("${event}") called while disconnected — message dropped`);
    return;
  }
  socket.emit(event, ...args);
}

/**
 * Registers a callback to be notified whenever the connection status changes.
 * Returns an unregister function.
 *
 * @example
 * const off = onStatusChange(setStatus);
 * return off; // inside useEffect cleanup
 */
export function onStatusChange(listener: StatusListener): () => void {
  statusListeners.add(listener);
  // Fire immediately with the current status so the caller doesn't have to
  // wait for the next transition to get an initial value
  listener(currentStatus);
  return () => statusListeners.delete(listener);
}

/**
 * Returns the current connection status synchronously.
 * Useful for one-off checks; prefer onStatusChange for reactive updates.
 */
export function getConnectionStatus(): ConnectionStatus {
  return currentStatus;
}
