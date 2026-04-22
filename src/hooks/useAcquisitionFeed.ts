import { useCallback, useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
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
  const socketRef = useRef<Socket | null>(null);

  const handleNewAcquisition = useCallback((event: PublicDealEvent) => {
    setDeals((prev) => [event, ...prev].slice(0, MAX_DEALS));
  }, []);

  useEffect(() => {
    // Empty string tells socket.io-client to connect to the same origin,
    // which is correct when the custom server serves both Next.js and sockets.
    const socket = io(SOCKET_URL, {
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 30_000,
      reconnectionAttempts: Infinity,
    });

    socketRef.current = socket;

    socket.on("connect", () => setIsConnected(true));
    socket.on("disconnect", () => setIsConnected(false));
    socket.on("new_acquisition", handleNewAcquisition);

    return () => {
      socket.off("new_acquisition", handleNewAcquisition);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [handleNewAcquisition]);

  return { deals, isConnected };
}
