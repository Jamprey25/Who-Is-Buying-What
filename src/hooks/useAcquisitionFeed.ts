import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import type { PublicDealEvent } from "../secEdgarFeed";

const MAX_DEALS = 50;
const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL ?? "";

export interface AcquisitionFeed {
  deals: PublicDealEvent[];
  isConnected: boolean;
}

export function useAcquisitionFeed(): AcquisitionFeed {
  const [deals, setDeals] = useState<PublicDealEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  const handleNewAcquisition = useCallback((event: PublicDealEvent) => {
    setDeals((prev) => [event, ...prev].slice(0, MAX_DEALS));
  }, []);

  const handleDealHistory = useCallback((events: unknown) => {
    if (!Array.isArray(events) || events.length === 0) return;
    const valid: PublicDealEvent[] = [];
    for (const e of events) {
      if (
        e &&
        typeof e === "object" &&
        typeof (e as PublicDealEvent).id === "string" &&
        typeof (e as PublicDealEvent).acquirer === "string" &&
        typeof (e as PublicDealEvent).target === "string" &&
        typeof (e as PublicDealEvent).announcedAt === "string"
      ) {
        valid.push(e as PublicDealEvent);
      }
    }
    if (valid.length === 0) return;
    setDeals((prev) => {
      const seen = new Set(prev.map((d) => d.id));
      const merged = [...prev];
      for (const d of valid) {
        if (!seen.has(d.id)) {
          merged.push(d);
          seen.add(d.id);
        }
      }
      merged.sort(
        (a, b) =>
          new Date(b.announcedAt).getTime() - new Date(a.announcedAt).getTime()
      );
      return merged.slice(0, MAX_DEALS);
    });
  }, []);

  // Keep latest handlers in refs so the socket effect can use a constant `[]`
  // dependency array. That avoids React's "dependency array changed size"
  // warning during Fast Refresh when the effect's deps list grows or shrinks
  // between saved versions of this file.
  const handlersRef = useRef({
    onNew: handleNewAcquisition,
    onHistory: handleDealHistory,
  });
  handlersRef.current = {
    onNew: handleNewAcquisition,
    onHistory: handleDealHistory,
  };

  useEffect(() => {
    // Empty string tells socket.io-client to connect to the same origin,
    // which is correct when the custom server serves both Next.js and sockets.
    const socket = io(SOCKET_URL, {
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 30_000,
      reconnectionAttempts: Infinity,
    });

    const onNew = (event: PublicDealEvent) => {
      handlersRef.current.onNew(event);
    };
    const onHistory = (events: unknown) => {
      handlersRef.current.onHistory(events);
    };

    socket.on("connect", () => setIsConnected(true));
    socket.on("disconnect", () => setIsConnected(false));
    socket.on("new_acquisition", onNew);
    socket.on("deal_history", onHistory);

    return () => {
      socket.off("new_acquisition", onNew);
      socket.off("deal_history", onHistory);
      socket.disconnect();
    };
  }, []);

  return { deals, isConnected };
}
