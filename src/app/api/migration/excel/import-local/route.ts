import { NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs/promises';
import path from 'path';
import { AppConfig } from '@/types/config';
import { detectEntityMismatch } from '@/lib/sap-schemas';

const CONFIG_FILE = path.join(process.cwd(), 'config.json');

async function getConfig(): Promise<AppConfig> {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(data);
}

const normalizeColumnName = (name: string) => {
    return name
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9_]/g, "_")
        .replace(/^_+|_+$/g, "");
};

export async function POST(request: Request) {
    console.log('--- Local Excel Import Started ---');
    try {
        const body = await request.json();
        const { entityId, testOnly, preview } = body;

        if (!entityId) {
            return NextResponse.json({ success: false, message: 'Entity ID não fornecido.' }, { status: 400 });
        }

        const config = await getConfig();
        const supabase = createClient(config.supabase.url, config.supabase.key, { auth: { persistSession: false } });

        const { data: entity, error: entityErr } = await supabase
            .from('migration_entities')
            .select('*')
            .eq('id', entityId)
            .single();

        if (entityErr || !entity || !entity.source_file_path || !entity.staging_table) {
            return NextResponse.json({ success: false, message: 'Entidade inválida ou sem arquivo vinculado.' }, { status: 400 });
        }

        const filePath = path.join(process.cwd(), 'imports', entity.source_file_path);
        
        if (testOnly) {
            try {
                await fs.access(filePath);
                return NextResponse.json({ success: true, message: 'Arquivo encontrado na pasta imports.' });
            } catch (e) {
                return NextResponse.json({ success: false, message: `O arquivo ${entity.source_file_path} não foi encontrado na pasta 'imports/' do projeto.` }, { status: 404 });
            }
        }

        let buffer;
        try {
            buffer = await fs.readFile(filePath);
        } catch (e) {
            return NextResponse.json({ success: false, message: `Arquivo '${entity.source_file_path}' não encontrado na pasta 'imports/'.` }, { status: 404 });
        }

        const workbook = XLSX.read(buffer);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];

        let rawData = XLSX.utils.sheet_to_json(worksheet, { defval: "" });
        if (!rawData || rawData.length === 0) {
            return NextResponse.json({ success: false, message: 'Planilha vazia ou inválida.' }, { status: 400 });
        }

        const columns = Object.keys(rawData[0] as object);

        if (rawData.length > 0) {
            rawData = rawData.slice(1);
        }

        console.log(`Parsed ${rawData.length} rows from local Excel: ${entity.source_file_path}`);

        let validation = detectEntityMismatch(entity.name, entity.target_object, columns);
        if (entity.target_object === 'BusinessPartners') {
            validation = { mismatch: false };
        }

        if (validation.mismatch) {
            return NextResponse.json({
                success: false,
                message: `A estrutura da planilha em 'imports/' não corresponde aos campos esperados para '${entity.name}'.`,
            }, { status: 400 });
        }

        if (preview) {
            const previewRows = rawData.slice(0, 5).map((row: any) => {
                const newRow: any = {};
                for (const key in row) {
                    newRow[normalizeColumnName(key)] = String(row[key] ?? '').trim();
                }
                return newRow;
            });
            return NextResponse.json({ success: true, data: previewRows });
        }

        const pgTableName = entity.staging_table;
        const sourcePkField = entity.source_pk_field;

        // Cleanup before insert
        await supabase.rpc('exec_sql', { query: `DROP TABLE IF EXISTS "${pgTableName}" CASCADE;` });
        
        const createBaseSql = `CREATE TABLE IF NOT EXISTS "${pgTableName}" (id bigint primary key generated always as identity, d_e_l_e_t_ text default '');`;
        await supabase.rpc('exec_sql', { query: createBaseSql });

        for (const col of columns) {
            const norm = normalizeColumnName(col);
            const alterSql = `ALTER TABLE "${pgTableName}" ADD COLUMN IF NOT EXISTS "${norm}" text;`;
            await supabase.rpc('exec_sql', { query: alterSql });
        }

        const metaCols = [
            ['__source_key', 'TEXT'],
            ['__sap_id', 'TEXT'],
            ['__integration_status', 'TEXT DEFAULT \'pending\''],
            ['__sync_message', 'TEXT'],
            ['__last_sync', 'TIMESTAMP WITH TIME ZONE']
        ];
        for (const [name, type] of metaCols) {
            await supabase.rpc('exec_sql', { query: `ALTER TABLE "${pgTableName}" ADD COLUMN IF NOT EXISTS "${name}" ${type};` });
        }

        if (sourcePkField) {
            await supabase.rpc('exec_sql', {
                query: `
                DO $$ 
                BEGIN 
                    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'idx_${pgTableName}_source_key_unique') THEN
                        ALTER TABLE "${pgTableName}" ADD CONSTRAINT "idx_${pgTableName}_source_key_unique" UNIQUE (__source_key);
                    END IF;
                END $$;`
            });
        }
        await supabase.rpc('exec_sql', { query: "NOTIFY pgrst, 'reload schema';" });
        
        await new Promise(r => setTimeout(r, 3000));

        const processedRows = rawData.map((row: any) => {
            const newRow: any = {};
            for (const key in row) {
                newRow[normalizeColumnName(key)] = String(row[key] ?? '').trim();
            }
            if (sourcePkField) {
                const pkVal = row[sourcePkField] || row[sourcePkField.toUpperCase()] || row[normalizeColumnName(sourcePkField)];
                if (pkVal) {
                    newRow['__source_key'] = String(pkVal).trim();
                }
            }
            return newRow;
        });

        // Insert in batches
        const batchSize = 100;
        let inserted = 0;
        for (let i = 0; i < processedRows.length; i += batchSize) {
            const batch = processedRows.slice(i, i + batchSize);

            let result;
            let retryCount = 0;
            const maxRetries = 2;
            let batchSuccess = false;
            let lastBatchError: any = null;

            while (retryCount <= maxRetries && !batchSuccess) {
                if (sourcePkField) {
                    result = await supabase.from(pgTableName).upsert(batch, { onConflict: '__source_key' });
                } else {
                    result = await supabase.from(pgTableName).insert(batch);
                }

                if (result.error) {
                    lastBatchError = result.error;
                    console.warn(`Error in batch ${i}, retry ${retryCount}:`, result.error.message);
                    await new Promise(r => setTimeout(r, 2000));
                    retryCount++;
                } else {
                    batchSuccess = true;
                }
            }

            if (!batchSuccess) {
                return NextResponse.json({ success: false, message: `Erro ao inserir lote: ${lastBatchError?.message}` }, { status: 500 });
            }
            inserted += batch.length;
        }

        return NextResponse.json({
            success: true,
            message: `Importação concluída: ${inserted} registros lidos do Excel local.`,
            rowsCopied: inserted
        });

    } catch (error: any) {
        console.error('Local Excel Import Error:', error);
        return NextResponse.json({ success: false, message: 'Erro fatal: ' + error.message }, { status: 500 });
    }
}
