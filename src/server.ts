import { createServer } from "node:http";
import { parse } from "node:url";
import next from "next";
import { Server } from "socket.io";

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
