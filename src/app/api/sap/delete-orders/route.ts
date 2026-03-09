import { NextResponse } from 'next/server';
import axios, { AxiosError } from 'axios';
import https from 'https';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs/promises';
import path from 'path';
import { AppConfig } from '@/types/config';

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

/** Busca todos os DocEntry de Orders do SAP com paginação */
async function fetchAllOrderDocEntries(serviceLayerUrl: string, cookieStr: string): Promise<number[]> {
    const PAGE = 50;
    const all: number[] = [];
    let skip = 0;

    while (true) {
        const url = `${serviceLayerUrl}/Orders?$select=DocEntry&$top=${PAGE}&$skip=${skip}`;
        const res = await axios.get<{ value: { DocEntry: number }[] }>(url, {
            httpsAgent,
            headers: { Cookie: cookieStr },
        });
        const items = res.data?.value ?? [];
        if (!items.length) break;
        all.push(...items.map((o) => o.DocEntry));
        console.log(`[delete-orders/all] Página: skip=${skip} → ${items.length} orders. Total até agora: ${all.length}`);
        if (items.length < PAGE) break;
        skip += PAGE;
    }

    return all;
}

/** Cancela um Sales Order no SAP (necessário antes de excluir). */
async function cancelOrder(serviceLayerUrl: string, cookieStr: string, docEntry: number): Promise<void> {
    await axios.post(
        `${serviceLayerUrl}/Orders(${docEntry})/Cancel`,
        {},
        { httpsAgent, headers: { Cookie: cookieStr } }
    );
}

/**
 * POST /api/sap/delete-orders
 *
 * Body (por lista):
 * {
 *   docEntries: number[]        // Lista de DocEntry
 *   cancelFirst?: boolean       // Cancela antes de excluir (default: true)
 *   clearWriteback?: boolean    // Zera sap_jdt_num no Supabase (default: true)
 *   sourceTable?: string        // Tabela Supabase para write-back
 * }
 *
 * Body (excluir TUDO):
 * {
 *   deleteAll: true             // Busca e exclui TODOS os Orders do SAP
 *   cancelFirst?: boolean
 *   clearWriteback?: boolean
 *   sourceTable?: string
 * }
 */
export async function POST(request: Request) {
    try {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

        const body = await request.json().catch(() => ({}));
        const deleteAll: boolean = body.deleteAll === true;
        const cancelFirst: boolean = body.cancelFirst !== false;
        const clearWriteback: boolean = body.clearWriteback !== false;
        const sourceTable: string = body.sourceTable ?? 'se1010';

        const config = await getConfig();
        const { serviceLayerUrl } = config.sap;
        const cookieStr = await sapLogin(config);

        // Resolve a lista de DocEntries
        let docEntries: number[];

        if (deleteAll) {
            console.log('[delete-orders] Modo DELETE ALL — buscando todos os Orders do SAP...');
            docEntries = await fetchAllOrderDocEntries(serviceLayerUrl, cookieStr);
            console.log(`[delete-orders] DELETE ALL: ${docEntries.length} orders encontrados.`);
        } else {
            docEntries = body.docEntries ?? [];
        }

        if (!docEntries.length) {
            return NextResponse.json({
                success: true,
                message: deleteAll
                    ? 'Nenhum Sales Order encontrado no SAP para excluir.'
                    : 'Nenhum DocEntry informado.',
                total: 0,
                deleted: 0,
                errors: 0,
                writebackCleared: 0,
                details: [],
            });
        }

        const results: { docEntry: number; status: 'deleted' | 'error'; message?: string; steps?: string[] }[] = [];

        for (let i = 0; i < docEntries.length; i++) {
            const docEntry = docEntries[i];
            const steps: string[] = [];
            console.log(`[delete-orders] Processando ${i + 1}/${docEntries.length} — DocEntry: ${docEntry}`);

            try {
                // Passo 1: Cancelar
                if (cancelFirst) {
                    try {
                        await cancelOrder(serviceLayerUrl, cookieStr, docEntry);
                        steps.push('cancelled');
                        console.log(`[delete-orders] Order ${docEntry} cancelada.`);
                    } catch (cancelErr: any) {
                        const msg = (cancelErr as AxiosError<any>)?.response?.data?.error?.message?.value ?? cancelErr.message;
                        steps.push(`cancel-warn: ${msg}`);
                        console.warn(`[delete-orders] Aviso ao cancelar Order ${docEntry}: ${msg}`);
                    }
                }

                // Passo 2: Excluir
                await axios.delete(`${serviceLayerUrl}/Orders(${docEntry})`, {
                    httpsAgent,
                    headers: { Cookie: cookieStr },
                });
                steps.push('deleted');
                results.push({ docEntry, status: 'deleted', steps });
                console.log(`[delete-orders] Order ${docEntry} excluída. (${i + 1}/${docEntries.length})`);

            } catch (err: any) {
                const sapMsg = (err as AxiosError<any>)?.response?.data?.error?.message?.value ?? err.message;
                steps.push(`error: ${sapMsg}`);
                results.push({ docEntry, status: 'error', message: sapMsg, steps });
                console.warn(`[delete-orders] Falha ao excluir Order ${docEntry}:`, sapMsg);
            }
        }

        // Write-back: zera sap_jdt_num no Supabase para os excluídos com sucesso
        const deletedEntries = results.filter(r => r.status === 'deleted').map(r => r.docEntry);
        let writebackCleared = 0;

        if (clearWriteback && deletedEntries.length > 0 && sourceTable) {
            const supabase = createClient(config.supabase.url, config.supabase.key, { auth: { persistSession: false } });

            if (deleteAll) {
                // Zera TODOS os registros da tabela de uma vez
                const { error, count } = await supabase
                    .from(sourceTable)
                    .update({ sap_jdt_num: null })
                    .not('sap_jdt_num', 'is', null);
                if (error) {
                    console.warn(`[delete-orders] write-back all clear failed for ${sourceTable}:`, error.message);
                } else {
                    writebackCleared = count ?? 0;
                }
            } else {
                const { error, count } = await supabase
                    .from(sourceTable)
                    .update({ sap_jdt_num: null })
                    .in('sap_jdt_num', deletedEntries);
                if (error) {
                    console.warn(`[delete-orders] write-back clear failed for ${sourceTable}:`, error.message);
                } else {
                    writebackCleared = count ?? 0;
                }
            }
            console.log(`[delete-orders] write-back: ${writebackCleared} registros de ${sourceTable} tiveram sap_jdt_num zerado.`);
        }

        const errors = results.filter(r => r.status === 'error');
        return NextResponse.json({
            success: errors.length === 0,
            total: docEntries.length,
            deleted: deletedEntries.length,
            errors: errors.length,
            writebackCleared,
            details: results,
        });

    } catch (error: any) {
        console.error('[delete-orders]', error?.response?.data || error.message);
        return NextResponse.json({
            success: false,
            message: error?.response?.data?.error?.message?.value || error.message,
        }, { status: 500 });
    }
}
