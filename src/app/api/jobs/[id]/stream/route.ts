import { open, stat } from "node:fs/promises";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { isTerminal } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Tail a job's Terraform log over Server-Sent Events.
 *
 * The worker appends to a file rather than holding output in memory, so this
 * just follows that file by offset. The consequence worth having: a user who
 * opens the page halfway through an apply sees everything from the start, not
 * only what happens after they arrived.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { id } = await params;
  const job = await prisma.job.findUnique({
    where: { id },
    include: { guest: { select: { ownerId: true } } },
  });

  if (!job) return new Response("Not found", { status: 404 });
  if (session.user.role !== "ADMIN" && job.guest.ownerId !== session.user.id) {
    return new Response("Not found", { status: 404 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let offset = 0;
      let closed = false;

      const send = (event: string, data: string) => {
        if (closed) return;
        // Every line needs its own data: field or the client sees one blob.
        const payload = data
          .split("\n")
          .map((line) => `data: ${line}`)
          .join("\n");
        controller.enqueue(encoder.encode(`event: ${event}\n${payload}\n\n`));
      };

      const pump = async (): Promise<boolean> => {
        try {
          const info = await stat(job.logPath);
          if (info.size > offset) {
            const handle = await open(job.logPath, "r");
            const length = info.size - offset;
            const buf = Buffer.alloc(length);
            await handle.read(buf, 0, length, offset);
            await handle.close();
            offset = info.size;
            send("log", buf.toString("utf8"));
          }
        } catch {
          // The worker may not have created the file yet; that is not an error.
        }

        const current = await prisma.job.findUnique({
          where: { id },
          select: { state: true, exitCode: true, error: true },
        });
        if (!current || isTerminal(current.state)) {
          send(
            "done",
            JSON.stringify({
              state: current?.state ?? "FAILED",
              exitCode: current?.exitCode ?? null,
              error: current?.error ?? null,
            }),
          );
          return true;
        }
        return false;
      };

      // Wall clock guard: a browser tab left open overnight should not hold a
      // database connection and a file handle forever.
      const deadline = Date.now() + 60 * 60_000;

      for (;;) {
        const finished = await pump();
        if (finished || Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 1_000));
      }

      closed = true;
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Without this a reverse proxy will happily buffer the whole apply.
      "X-Accel-Buffering": "no",
    },
  });
}
