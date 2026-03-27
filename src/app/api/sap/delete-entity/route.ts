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
 * POST /api/sap/delete-entity
 *
 * Body: {
 *   entityObject: string       // ex: 'BusinessPartners', 'Items', 'ProfitCenters'
 *   keys: string[] | number[]  // Lista de chaves primárias
 *   deleteAllFromTable?: boolean
 *   clearWriteback?: boolean   // default: true
 *   sourceTable?: string       // ex: 'stg_parceiros'
 * }
 */
export async function POST(request: Request) {
    try {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

        const body = await request.json().catch(() => ({}));
        const entityObject: string = body.entityObject;
        let keys: (string | number)[] = body.keys ?? [];
        const deleteAllFromTable: boolean = body.deleteAllFromTable === true;
        const clearWriteback: boolean = body.clearWriteback !== false;
        const sourceTable: string | null = body.sourceTable ?? null;

        if (!entityObject) {
            return NextResponse.json({ success: false, message: 'entityObject não informado.' }, { status: 400 });
        }

        const config = await getConfig();
        const supabase = createClient(config.supabase.url, config.supabase.key, { auth: { persistSession: false } });

        let discoveredTargetColumn = '__sap_id';

        if (deleteAllFromTable && sourceTable) {
            let { data, error } = await supabase
                .from(sourceTable)
                .select(discoveredTargetColumn)
                .not(discoveredTargetColumn, 'is', null);

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
                return NextResponse.json({ success: false, message: `Erro ao buscar chaves na tabela ${sourceTable}: ${error.message}` }, { status: 500 });
            }

            keys = data!.map((r: any) => r[discoveredTargetColumn]).filter(Boolean);
            console.log(`[delete-entity] Encontradas ${keys.length} chaves para deletar de ${sourceTable}`);
        } else if (sourceTable) {
            // Apenas para descobrir a coluna target se necessário pro writeback
            const { error } = await supabase.from(sourceTable).select('__sap_id').limit(1);
            if (error && error.message.includes('does not exist')) {
                discoveredTargetColumn = 'sap_code';
            }
        }

        if (!keys.length) {
            return NextResponse.json({ success: false, message: 'Nenhuma chave (ID) informada ou encontrada na tabela.' }, { status: 400 });
        }

        const { serviceLayerUrl } = config.sap;
        const cookieStr = await sapLogin(config);

        const results: { key: string | number; status: 'deleted' | 'error'; message?: string }[] = [];

        // Exclui um a um
        for (const key of keys) {
            try {
                // Determine if key is numeric or string for OData. 
                // Mostly Items/BP/CostCenters are strings.
                const isNumeric = typeof key === 'number' || !isNaN(Number(key)); // Basic heuristic, but string keys like "001" exist.
                // We'll treat all as strings except known numeric targets if needed, 
                // but actually let's assume if it is typeof number then no quotes, else quotes.
                // Actually, SAP B1 Items/BPs/ProfitCenters always take string keys even if they look like "001".
                let encodedKey = key;
                if (typeof key === 'string') {
                    encodedKey = encodeURIComponent(`'${key}'`);
                } else if (typeof key === 'number') {
                    // Just the number
                    encodedKey = key.toString();
                }

                await axios.delete(`${serviceLayerUrl}/${entityObject}(${encodedKey})`, {
                    httpsAgent,
                    headers: { Cookie: cookieStr },
                });
                results.push({ key, status: 'deleted' });
                console.log(`[delete-entity] ${entityObject}(${key}) excluído com sucesso.`);
            } catch (err: any) {
                const sapMsg = (err as AxiosError<any>)?.response?.data?.error?.message?.value
                    ?? err.message;
                results.push({ key, status: 'error', message: sapMsg });
                console.warn(`[delete-entity] Falha ao excluir ${entityObject}(${key}):`, sapMsg);
            }
        }

        // Write-back: zera a referência nos registros
        const deletedKeys = results.filter(r => r.status === 'deleted').map(r => r.key);
        let writebackCleared = 0;

        if (clearWriteback && deletedKeys.length > 0 && sourceTable) {
            const { error, count } = await supabase
                .from(sourceTable)
                .update({ [discoveredTargetColumn]: null })
                .in(discoveredTargetColumn, deletedKeys);

            if (error) {
                console.warn(`[delete-entity] write-back failed for ${sourceTable}:`, error.message);
            } else {
                writebackCleared += count ?? 0;
            }
        }

        const errors = results.filter(r => r.status === 'error');
        return NextResponse.json({
            success: errors.length === 0,
            total: keys.length,
            deleted: deletedKeys.length,
            errors: errors.length,
            writebackCleared,
            details: results,
        });

    } catch (error: any) {
        console.error('[delete-entity]', error?.response?.data || error.message);
        return NextResponse.json({
            success: false,
            message: error?.response?.data?.error?.message?.value || error.message,
        }, { status: 500 });
    }
}
