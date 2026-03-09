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

/**
 * POST /api/sap/delete-journal-entries
 *
 * Body: {
 *   jdtNums: number[]          // Lista de DocEntry (JdtNum) a excluir
 *   clearWriteback?: boolean   // Se true, zera sap_jdt_num no Supabase após excluir (default: true)
 * }
 *
 * Exclui os Journal Entries do SAP B1 via Service Layer e,
 * opcionalmente, limpa o campo sap_jdt_num nas tabelas se2010/se1010 do Supabase.
 */
export async function POST(request: Request) {
    try {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

        const body = await request.json().catch(() => ({}));
        const jdtNums: number[] = body.jdtNums ?? [];
        const clearWriteback: boolean = body.clearWriteback !== false; // default true
        const sourceTable: 'se2010' | 'se1010' | null = body.sourceTable ?? null; // para limpar writeback

        if (!jdtNums.length) {
            return NextResponse.json({ success: false, message: 'Nenhum JdtNum informado.' }, { status: 400 });
        }

        const config = await getConfig();
        const { serviceLayerUrl } = config.sap;
        const cookieStr = await sapLogin(config);

        const results: { jdtNum: number; status: 'deleted' | 'error'; message?: string }[] = [];

        // Exclui um a um (SAP não suporta bulk delete via Service Layer)
        for (const jdtNum of jdtNums) {
            try {
                await axios.delete(`${serviceLayerUrl}/JournalEntries(${jdtNum})`, {
                    httpsAgent,
                    headers: { Cookie: cookieStr },
                });
                results.push({ jdtNum, status: 'deleted' });
                console.log(`[delete-je] JournalEntry ${jdtNum} excluído com sucesso.`);
            } catch (err: any) {
                const sapMsg = (err as AxiosError<any>)?.response?.data?.error?.message?.value
                    ?? err.message;
                results.push({ jdtNum, status: 'error', message: sapMsg });
                console.warn(`[delete-je] Falha ao excluir JournalEntry ${jdtNum}:`, sapMsg);
            }
        }

        // Write-back: zera sap_jdt_num nos registros que foram excluídos com sucesso
        const deleted = results.filter(r => r.status === 'deleted').map(r => r.jdtNum);
        let writebackCleared = 0;

        if (clearWriteback && deleted.length > 0) {
            const supabase = createClient(config.supabase.url, config.supabase.key, { auth: { persistSession: false } });
            const tables = sourceTable ? [sourceTable] : ['se2010', 'se1010'];

            for (const tbl of tables) {
                const { error, count } = await supabase
                    .from(tbl)
                    .update({ sap_jdt_num: null })
                    .in('sap_jdt_num', deleted);
                if (error) {
                    console.warn(`[delete-je] write-back clear failed for ${tbl}:`, error.message);
                } else {
                    writebackCleared += count ?? 0;
                    console.log(`[delete-je] write-back: ${count ?? 0} registros de ${tbl} tiveram sap_jdt_num zerado.`);
                }
            }
        }

        const errors = results.filter(r => r.status === 'error');
        return NextResponse.json({
            success: errors.length === 0,
            total: jdtNums.length,
            deleted: deleted.length,
            errors: errors.length,
            writebackCleared,
            details: results,
        });

    } catch (error: any) {
        console.error('[delete-journal-entries]', error?.response?.data || error.message);
        return NextResponse.json({
            success: false,
            message: error?.response?.data?.error?.message?.value || error.message,
        }, { status: 500 });
    }
}
