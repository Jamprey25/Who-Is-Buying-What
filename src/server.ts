import { createServer } from "node:http";
import { parse } from "node:url";
import next from "next";
import { Server } from "socket.io";
import type { DealRecord, PublicDealEvent } from "./secEdgarFeed";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST ?? "localhost";
const port = Number(process.env.PORT ?? 3000);
const frontendOrigin = process.env.FRONTEND_ORIGIN ?? `http://${hostname}:${port}`;

let io: Server | null = null;

export function getIO(): Server {
  if (!io) {
    throw new Error("Socket.io has not been initialised yet. Call getIO() after the server has started.");
  }
  return io;
}

const BILLION = 1_000_000_000;

/** In-memory ring buffer so late-connecting browsers see recent deals. */
const MAX_RECENT_DEALS = 50;
const recentAcquisitions: PublicDealEvent[] = [];

export function broadcastNewAcquisition(deal: DealRecord): void {
  const server = getIO();

  const event: PublicDealEvent = {
    id: deal.id,
    acquirer: deal.acquirer,
    target: deal.target,
    announcedAt: deal.announcedAt.toISOString(),
    sourceUrl: deal.sourceUrl,
    transactionValueUSD: deal.transactionValueUSD,
  };

  recentAcquisitions.unshift(event);
  if (recentAcquisitions.length > MAX_RECENT_DEALS) {
    recentAcquisitions.length = MAX_RECENT_DEALS;
  }

  server.emit("new_acquisition", event);

  if (deal.transactionValueUSD !== null && deal.transactionValueUSD > BILLION) {
    server.to("billion_dollar_club").emit("new_acquisition", event);
  }

  const clientCount = server.engine.clientsCount;
  console.log(
    `[broadcast] new_acquisition id=${deal.id} acquirer="${deal.acquirer}" target="${deal.target}" clients=${clientCount}`
  );
}

async function main(): Promise<void> {
  const app = next({ dev, hostname, port });
  const handle = app.getRequestHandler();

  await app.prepare();

  const httpServer = createServer((req, res) => {
    const parsedUrl = parse(req.url ?? "/", true);
    void handle(req, res, parsedUrl);
  });

  io = new Server(httpServer, {
    cors: {
      origin: frontendOrigin,
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    console.log(`[socket.io] client connected: ${socket.id}`);

    // Replay recent deals so the UI is not empty after a refresh or if the
    // client connected after broadcasts already fired.
    socket.emit("deal_history", [...recentAcquisitions]);

    socket.on("disconnect", (reason) => {
      console.log(`[socket.io] client disconnected: ${socket.id} (${reason})`);
    });
  });

  httpServer.listen(port, hostname, () => {
    console.log(`> Ready on http://${hostname}:${port} (${dev ? "dev" : "production"})`);
  });
}

main().catch((err: unknown) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
