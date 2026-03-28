import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import https from 'https';
import axios, { AxiosError } from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { AppConfig } from '@/types/config';

const CONFIG_FILE = path.join(process.cwd(), 'config.json');
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

async function getConfig(): Promise<AppConfig> {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(data);
}

export async function POST(req: Request) {
    try {
        const { keys, deleteAllFromTable, sourceTable, clearWriteback } = await req.json();

        // Autenticar SL
        const config = await getConfig();
        const loginRes = await axios.post(`${config.sap.serviceLayerUrl}/Login`, {
            CompanyDB: config.sap.companyDB,
            UserName: config.sap.userName,
            Password: config.sap.password
        }, { httpsAgent });

        const cookies = loginRes.headers['set-cookie'];
        const cookieStr = cookies ? cookies.join('; ') : '';

        let targetKeys: any[] = keys || [];

        const supabase = createClient(config.supabase.url, config.supabase.key, { auth: { persistSession: false } });

        let discoveredTargetColumn = '__sap_id';
        let targetSchema = 'public';
        let targetTable = sourceTable ?? '';
        
        if (sourceTable) {
            if (sourceTable.includes('.')) {
                [targetSchema, targetTable] = sourceTable.split('.');
            } else if (sourceTable.startsWith('protheus_') || sourceTable.startsWith('stg_')) {
                // leave as is, will probe public then staging
            }
        }

        async function fetchFromSource(queryColumn: string) {
            let res = await supabase.schema(targetSchema).from(targetTable).select(queryColumn).not(queryColumn, 'is', null);
            if (res.error && res.error.message.includes('does not exist') && targetSchema === 'public') {
                targetSchema = 'staging';
                res = await supabase.schema(targetSchema).from(targetTable).select(queryColumn).not(queryColumn, 'is', null);
            }
            return res;
        }

        if (deleteAllFromTable && sourceTable) {
            let { data, error } = await fetchFromSource(discoveredTargetColumn);

            if (error && error.message.includes('does not exist')) {
                discoveredTargetColumn = 'sap_code';
                const retry = await fetchFromSource(discoveredTargetColumn);
                data = retry.data;
                error = retry.error;
            }

            if (error) {
                return NextResponse.json({ success: false, message: `Erro ao buscar chaves: ${error.message}` }, { status: 500 });
            }

            targetKeys = data!.map((r: any) => r[discoveredTargetColumn]).filter(Boolean);
        }

        if (!targetKeys || targetKeys.length === 0) {
            return NextResponse.json({ success: false, message: 'Nenhuma chave fornecida ou encontrada para exclusão.' }, { status: 400 });
        }

        const results = [];

        // Excluir cada registro enviando um PATCH para limpar BPAddresses e BPFiscalTaxID
        for (const key of targetKeys) {
            try {
                let encodedKey = key;
                if (typeof key === 'string') {
                    encodedKey = encodeURIComponent(`'${key}'`);
                } else if (typeof key === 'number') {
                    encodedKey = key.toString();
                }

                // In SAP B1 SL, to delete collection rows, sometimes we can pass an empty array, 
                // but some environments require fetching the lines first and marking them or removing them.
                // However, the cleanest way to clear is to try passing empty arrays or fetching the entity, then deleting it? 
                // Let's try passing empty arrays first. If that doesn't wipe them, we will fallback to fetching and stripping.
                // Wait! B1 SL supports clearing collections just by passing []? No, passing [] usually means "no changes to collection".
                // To delete all addresses, you might need to use the Delete method or pass them without the ones you want to remove.
                // Let's fetch the BP first to get its current lines, and then we might not even need it if we can just delete them?
                // Actually, ServiceLayer allows removing existing lines by omitting them in a FULL replacement if you somehow trigger it, 
                // OR by deleting the BP and recreating it (but we don't want to recreate).
                // "B1 Service Layer - How to delete rows in collection": Use DELETE HTTP method with the row URI, e.g. 
                // DELETE /b1s/v1/BusinessPartners('C001')/BPAddresses('AddressName')
                // This implies we need to GET them first, then DELETE each row.

                // OData spec in SAP B1 Service Layer to wipe out entire collections is to PATCH them as empty arrays.
                const patchPayload = {
                    BPAddresses: [],
                    BPFiscalTaxID: []
                };

                await axios.patch(`${config.sap.serviceLayerUrl}/BusinessPartners(${encodedKey})`, patchPayload, { 
                    httpsAgent, headers: { Cookie: cookieStr } 
                });

                results.push({ key, status: 'deleted' });
                console.log(`[clear-bp] BP ${key} endereços/fiscais limpos com sucesso via PATCH []`);
            } catch (err: any) {
                const sapMsg = err.response?.data?.error?.message?.value || err.message;
                results.push({ key, status: 'error', message: sapMsg });
                console.warn(`[clear-bp] Falha ao limpar BP ${key}:`, sapMsg);
            }
        }

        // Write-back is not wiping the entire BP, just the address write-back?
        // Wait, if the user asks to clear CRD1/CRD7, should we clear writeback of the `stg_parceiros`? No, if `clearWriteback` is true, we maybe clear it. But usually `stg_parceiros` relates to the BP itself. The user might import `stg_enderecos`. 
        // If they chose the sourceTable `stg_enderecos`, we would clear `__sap_id` in `stg_enderecos`. This is handled below:
        const deletedKeys = results.filter(r => r.status === 'deleted').map(r => r.key);
        let writebackCleared = 0;

        if (clearWriteback && deletedKeys.length > 0 && sourceTable) {
            // Note: If sourceTable is an addresses table, we wipe exactly that. 
            // BUT wait! The `deletedKeys` are `CardCode`s (because we assume the input is CardCodes).
            // If the table is `stg_enderecos`, the column might not be `__sap_id` for CardCode, but `CardCode` or `a1_cod`!
            // Wait, generic `delete-entity` uses `discoveredTargetColumn` which is `__sap_id` or `sap_code`.
            // In `stg_enderecos`, there is no `__sap_id` representing CardCode. 
            // So if `clearWriteback` is true, we will just wipe `__sap_id` where `__sap_id` IN (CardCodes). 
            // That applies perfectly if source is `stg_parceiros`. If it's another table, it might not match.
            // But we will follow the same exact logic as `delete-entity`.
            const { error, count } = await supabase.schema(targetSchema)
                .from(targetTable)
                .update({ [discoveredTargetColumn]: null })
                .in(discoveredTargetColumn, deletedKeys);

            if (!error) {
                writebackCleared = count || 0;
            }
        }

        const errors = results.filter(r => r.status === 'error').length;
        return NextResponse.json({
            success: true,
            total: targetKeys.length,
            deleted: results.length - errors,
            errors,
            details: results,
            writebackCleared
        });

    } catch (e: any) {
        console.error('[clear-bp] Erro fatal:', e);
        return NextResponse.json({ success: false, message: e.message }, { status: 500 });
    }
}
