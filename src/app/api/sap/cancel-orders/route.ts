import axios, { AxiosError } from 'axios';
import https from 'https';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs/promises';
import path from 'path';
import { AppConfig } from '@/types/config';
import { NextResponse } from 'next/server';

const CONFIG_FILE = path.join(process.cwd(), 'config.json');
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

async function getConfig(): Promise<AppConfig> {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(data);
}

async function sapLogin(config: AppConfig): Promise<string> {
    const { serviceLayerUrl, companyDB, userName, password, language } = config.sap;
    const res = await axios.post(`${serviceLayerUrl}/Login`, {
        CompanyDB: companyDB, UserName: userName, Password: password, Language: language || 29,
    }, { httpsAgent, headers: { 'Content-Type': 'application/json' } });
    return (res.headers['set-cookie'] || []).join('; ');
}

/**
 * Busca TODOS os DocEntry de Orders via paginação com @odata.nextLink.
 * Não usa $filter para evitar problemas de paginação com OData do SAP B1.
 * A exclusão de pedidos já fechados é tratada na fase de cancelamento.
 */
type OrderPage = {
    value: { DocEntry: number; DocumentStatus?: string; Cancelled?: string }[];
    'odata.nextLink'?: string;
    '@odata.nextLink'?: string;
};

/**
 * FASE 1 — Varredura completa: monta a lista de todos os DocEntries de Sales Orders
 * que devem ser cancelados.
 *
 * Estratégia robusta:
 * - $top=20 (limite conservador, abaixo do max padrão do SAP B1)
 * - Paginação por $skip acumulado
 * - Para SOMENTE quando o retorno vem vazio (nunca por "página incompleta")
 *   → isso evita parar prematuramente quando o SAP tem seu próprio teto de paginação
 * - Filtra por DocumentStatus eq 'bost_Open' direto na query OData
 *   → mais eficiente e confiável que filtro local
 */
async function fetchAllOpenOrderDocEntries(
    serviceLayerUrl: string,
    cookieStr: string,
    send: (data: Record<string, unknown>) => void
): Promise<number[]> {
    const PAGE = 20;   // conservador — respeita o teto padrão do SAP Service Layer
    const all: number[] = [];
    let skip = 0;
    let page = 0;

    while (true) {
        page++;

        // Tenta com OData filter primeiro
        const url = `${serviceLayerUrl}/Orders?$select=DocEntry,DocumentStatus,Cancelled`
            + `&$filter=DocumentStatus eq 'bost_Open'`
            + `&$top=${PAGE}&$skip=${skip}`;

        send({
            type: 'fetching',
            message: `📄 Página ${page} — offset ${skip} — ${all.length} aberto(s) coletado(s) até agora...`,
        });

        let items: { DocEntry: number; DocumentStatus?: string; Cancelled?: string }[] = [];
        try {
            const res = await axios.get<OrderPage>(url, {
                httpsAgent,
                headers: { Cookie: cookieStr },
            });
            items = res.data?.value ?? [];
        } catch (err: any) {
            // Se o $filter der erro (alguns SLs não suportam), tenta sem filtro
            const errMsg: string = (err as import('axios').AxiosError<any>)?.response?.data?.error?.message?.value ?? err.message ?? '';
            send({ type: 'fetching', message: `   ⚠ Filtro OData falhou (${errMsg.slice(0, 60)}). Tentando sem filtro...` });

            const fallbackUrl = `${serviceLayerUrl}/Orders?$select=DocEntry,DocumentStatus,Cancelled&$top=${PAGE}&$skip=${skip}`;
            const res2 = await axios.get<OrderPage>(fallbackUrl, {
                httpsAgent,
                headers: { Cookie: cookieStr },
            });
            const allItems = res2.data?.value ?? [];
            // Filtra localmente quando o OData $filter falha
            items = allItems.filter(o => o.DocumentStatus === 'bost_Open' && o.Cancelled !== 'tYES');
        }

        if (items.length === 0) {
            // Retorno vazio = chegamos ao fim da lista
            send({ type: 'fetching', message: `   → Página ${page}: 0 registros — varredura concluída.` });
            break;
        }

        // Adiciona os DocEntries (garante que não cancelados entrem)
        const toCancel = items.filter(o => o.Cancelled !== 'tYES');
        all.push(...toCancel.map(o => o.DocEntry));

        send({
            type: 'fetching',
            message: `   → Página ${page}: ${items.length} aberto(s) nesta página (skip=${skip}). Acumulado: ${all.length}`,
        });

        // Avança o offset sempre pelo tamanho real retornado
        skip += items.length;
    }

    send({
        type: 'fetching',
        message: `✅ Varredura concluída: ${page} página(s). ${all.length} pedido(s) em aberto para cancelar.`,
    });

    return all;
}

/**
 * POST /api/sap/cancel-orders  (streaming SSE)
 *
 * Body: {
 *   cancelAll?: boolean         // Busca e cancela TODOS os Orders abertos
 *   docEntries?: number[]       // OU lista específica de DocEntry
 *   clearWriteback?: boolean    // Zera __sap_id no Supabase (default: true)
 *   sourceTable?: string        // Tabela Supabase (default: 'se1010')
 * }
 *
 * Retorna: text/event-stream com eventos JSON
 */
export async function POST(request: Request) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    const body = await request.json().catch(() => ({}));
    const cancelAll: boolean = body.cancelAll === true;
    const clearWriteback: boolean = body.clearWriteback !== false;
    const sourceTable: string = body.sourceTable ?? 'se1010';

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        async start(controller) {
            const send = (data: Record<string, unknown>) => {
                try {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
                } catch { /* stream closed */ }
            };

            try {
                send({ type: 'start', message: '🔑 Conectando ao SAP...' });

                const config = await getConfig();
                const { serviceLayerUrl } = config.sap;
                const cookieStr = await sapLogin(config);

                send({ type: 'start', message: '✓ Login no SAP realizado.' });

                // ── Resolve lista de DocEntries ───────────────────────────────
                let docEntries: number[];

                if (cancelAll) {
                    send({ type: 'fetching', message: '🔍 Buscando todos os pedidos em aberto no SAP (com paginação)...' });
                    docEntries = await fetchAllOpenOrderDocEntries(serviceLayerUrl, cookieStr, send);
                    send({
                        type: 'fetched',
                        total: docEntries.length,
                        message: `✓ Total de pedidos abertos encontrados: ${docEntries.length}`,
                    });
                } else {
                    docEntries = body.docEntries ?? [];
                    send({ type: 'fetched', total: docEntries.length, message: `📋 ${docEntries.length} pedido(s) na lista.` });
                }

                if (!docEntries.length) {
                    send({ type: 'done', total: 0, cancelled: 0, errors: 0, writebackCleared: 0, message: 'Nenhum pedido aberto encontrado para cancelar.' });
                    controller.close();
                    return;
                }

                // ── Cancela um a um ───────────────────────────────────────────
                let cancelled = 0;
                let skipped = 0;
                let errors = 0;

                for (let i = 0; i < docEntries.length; i++) {
                    const docEntry = docEntries[i];
                    const current = i + 1;

                    send({
                        type: 'progress',
                        current,
                        total: docEntries.length,
                        docEntry,
                        status: 'processing',
                        message: `[${current}/${docEntries.length}] Cancelando DocEntry=${docEntry}...`,
                    });

                    try {
                        await axios.post(
                            `${serviceLayerUrl}/Orders(${docEntry})/Cancel`,
                            {},
                            { httpsAgent, headers: { Cookie: cookieStr } }
                        );
                        cancelled++;
                        send({
                            type: 'progress',
                            current,
                            total: docEntries.length,
                            docEntry,
                            status: 'cancelled',
                            message: `[${current}/${docEntries.length}] ✓ DocEntry=${docEntry} cancelado.`,
                        });
                        console.log(`[cancel-orders] ${current}/${docEntries.length} DocEntry=${docEntry} cancelado.`);
                    } catch (err: any) {
                        const sapMsg: string = (err as AxiosError<any>)?.response?.data?.error?.message?.value ?? err.message ?? '';
                        const alreadyClosed = sapMsg.toLowerCase().includes('closed') || sapMsg.toLowerCase().includes('cancelado') || sapMsg.toLowerCase().includes('cancelled');

                        if (alreadyClosed) {
                            skipped++;
                            send({
                                type: 'progress',
                                current,
                                total: docEntries.length,
                                docEntry,
                                status: 'cancelled',
                                message: `[${current}/${docEntries.length}] ↷ DocEntry=${docEntry} — já fechado/cancelado, ignorado.`,
                            });
                        } else {
                            errors++;
                            send({
                                type: 'progress',
                                current,
                                total: docEntries.length,
                                docEntry,
                                status: 'error',
                                message: `[${current}/${docEntries.length}] ✕ DocEntry=${docEntry} — ${sapMsg}`,
                            });
                            console.warn(`[cancel-orders] Falha DocEntry=${docEntry}: ${sapMsg}`);
                        }
                    }
                }

                // ── Write-back ────────────────────────────────────────────────
                let writebackCleared = 0;
                if (clearWriteback && cancelled > 0) {
                    send({ type: 'writeback', message: `🔄 Zerando vínculos de integração (__sap_id e sap_jdt_num) em ${sourceTable}...` });
                    const supabase = createClient(config.supabase.url, config.supabase.key, { auth: { persistSession: false } });

                    const clearField = async (field: '__sap_id' | 'sap_jdt_num') => {
                        if (cancelAll) {
                            return supabase.from(sourceTable).update({ [field]: null }).not(field, 'is', null);
                        }
                        return supabase.from(sourceTable).update({ [field]: null }).in(field, docEntries);
                    };

                    const sapIdRes = await clearField('__sap_id');
                    if (sapIdRes.error) {
                        send({ type: 'writeback', message: `⚠ Falha ao zerar __sap_id: ${sapIdRes.error.message}` });
                    }

                    const sapJdtRes = await clearField('sap_jdt_num');
                    if (sapJdtRes.error) {
                        // Algumas tabelas podem não possuir sap_jdt_num; segue fluxo sem abortar.
                        send({ type: 'writeback', message: `⚠ Falha ao zerar sap_jdt_num: ${sapJdtRes.error.message}` });
                    }

                    writebackCleared = (sapIdRes.count ?? 0) + (sapJdtRes.count ?? 0);
                    send({
                        type: 'writeback',
                        message: `✓ Limpeza concluída: __sap_id=${sapIdRes.count ?? 0}, sap_jdt_num=${sapJdtRes.count ?? 0}.`,
                    });
                }

                // ── Conclusão ─────────────────────────────────────────────────
                const msg = `✅ Concluído: ${cancelled} cancelado(s)${skipped > 0 ? `, ${skipped} já fechado(s) ignorado(s)` : ''}, ${errors} erro(s).`;
                send({
                    type: 'done',
                    total: docEntries.length,
                    cancelled,
                    skipped,
                    errors,
                    writebackCleared,
                    message: msg,
                });
                console.log(`[cancel-orders] ${msg}`);

            } catch (err: any) {
                const msg = (err as AxiosError<any>)?.response?.data?.error?.message?.value ?? err.message;
                console.error('[cancel-orders]', msg);
                send({ type: 'error', message: msg });
            } finally {
                controller.close();
            }
        },
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        },
    });
}

export async function GET() {
    return NextResponse.json({ ok: true });
}
