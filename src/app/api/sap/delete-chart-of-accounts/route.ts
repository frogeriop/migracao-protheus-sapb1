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
 * POST /api/sap/delete-chart-of-accounts
 *
 * Body: {
 *   acctCodes: string[]        // Lista de Codes (AcctCode) a excluir
 *   clearWriteback?: boolean   // Se true, zera __sap_id no Supabase após excluir (default: true)
 *   sourceTable?: string       // ex: 'EXCEL_123456'
 * }
 */
export async function POST(request: Request) {
    try {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

        const body = await request.json().catch(() => ({}));
        let acctCodes: string[] = body.acctCodes ?? [];
        const deleteAllFromTable: boolean = body.deleteAllFromTable === true;
        const clearWriteback: boolean = body.clearWriteback !== false; // default true
        const sourceTable: string | null = body.sourceTable ?? null;

        const config = await getConfig();
        const supabase = createClient(config.supabase.url, config.supabase.key, { auth: { persistSession: false } });

        let discoveredTargetColumn = '__sap_id'; // default to excel

        if (deleteAllFromTable && sourceTable) {
            let { data, error } = await supabase
                .from(sourceTable)
                .select(discoveredTargetColumn)
                .not(discoveredTargetColumn, 'is', null);

            // Se der erro de coluna não existe, tenta 'sap_code'
            if (error && error.message.includes('does not exist')) {
                discoveredTargetColumn = 'sap_code';
                const retry = await supabase
                    .from(sourceTable)
                    .select(discoveredTargetColumn)
                    .not(discoveredTargetColumn, 'is', null);
                data = retry.data;
                error = retry.error;
            }

            if (error) {
                return NextResponse.json({ success: false, message: `Erro ao buscar contas na tabela ${sourceTable}: ${error.message}` }, { status: 500 });
            }

            acctCodes = data!.map((r: any) => r[discoveredTargetColumn]).filter(Boolean);
            console.log(`[delete-coa] Encontrados ${acctCodes.length} contas para deletar da tabela ${sourceTable}`);
        } else if (sourceTable) {
            // Apenas para descobrir a coluna para o writeback quando não é 'all'
            const { error } = await supabase.from(sourceTable).select('__sap_id').limit(1);
            if (error && error.message.includes('does not exist')) {
                discoveredTargetColumn = 'sap_code';
            }
        }

        if (!acctCodes.length) {
            return NextResponse.json({ success: false, message: 'Nenhum AcctCode/Code informado ou encontrado na tabela.' }, { status: 400 });
        }

        const { serviceLayerUrl } = config.sap;
        const cookieStr = await sapLogin(config);

        const results: { code: string; status: 'deleted' | 'error'; message?: string }[] = [];

        // Exclui um a um
        for (const code of acctCodes) {
            try {
                // Service Layer string identifiers use single quotes
                const encodedCode = encodeURIComponent(`'${code}'`);
                await axios.delete(`${serviceLayerUrl}/ChartOfAccounts(${encodedCode})`, {
                    httpsAgent,
                    headers: { Cookie: cookieStr },
                });
                results.push({ code, status: 'deleted' });
                console.log(`[delete-coa] ChartOfAccounts ${code} excluído com sucesso.`);
            } catch (err: any) {
                const sapMsg = (err as AxiosError<any>)?.response?.data?.error?.message?.value
                    ?? err.message;
                results.push({ code, status: 'error', message: sapMsg });
                console.warn(`[delete-coa] Falha ao excluir ChartOfAccounts ${code}:`, sapMsg);
            }
        }

        // Write-back: zera a referência nos registros que foram excluídos com sucesso
        const deleted = results.filter(r => r.status === 'deleted').map(r => r.code);
        let writebackCleared = 0;

        if (clearWriteback && deleted.length > 0 && sourceTable) {
            const { error, count } = await supabase
                .from(sourceTable)
                .update({ [discoveredTargetColumn]: null })
                .in(discoveredTargetColumn, deleted);

            if (error) {
                console.warn(`[delete-coa] write-back clear failed for ${sourceTable} on column ${discoveredTargetColumn}:`, error.message);
            } else {
                writebackCleared += count ?? 0;
                console.log(`[delete-coa] write-back: ${count ?? 0} registros de ${sourceTable} tiveram ${discoveredTargetColumn} zerado.`);
            }
        }

        const errors = results.filter(r => r.status === 'error');
        return NextResponse.json({
            success: errors.length === 0,
            total: acctCodes.length,
            deleted: deleted.length,
            errors: errors.length,
            writebackCleared,
            details: results,
        });

    } catch (error: any) {
        console.error('[delete-chart-of-accounts]', error?.response?.data || error.message);
        return NextResponse.json({
            success: false,
            message: error?.response?.data?.error?.message?.value || error.message,
        }, { status: 500 });
    }
}
