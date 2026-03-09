/**
 * GET /api/control-tower/logs
 * Server-Sent Events endpoint que transmite logs reais do processo Next.js.
 *
 * Formato SSE:
 *   data: {"id":1,"ts":"21:05:33","level":"INFO","source":"preview","message":"..."}
 *
 * O cliente conecta e recebe:
 *   1. Os últimos 100 entries já no buffer (histórico imediato)
 *   2. Cada novo log em tempo real enquanto a conexão estiver aberta
 */
import { logBuffer } from '@/lib/logBuffer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        start(controller) {
            // Send historical entries immediately
            const history = logBuffer.getLast(100);
            for (const entry of history) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(entry)}\n\n`));
            }

            // Subscribe to new entries
            const unsubscribe = logBuffer.subscribe((entry) => {
                try {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(entry)}\n\n`));
                } catch {
                    unsubscribe();
                }
            });

            // Heartbeat every 15s to keep connection alive
            const heartbeat = setInterval(() => {
                try {
                    controller.enqueue(encoder.encode(': heartbeat\n\n'));
                } catch {
                    clearInterval(heartbeat);
                    unsubscribe();
                }
            }, 15000);
        },
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        },
    });
}
