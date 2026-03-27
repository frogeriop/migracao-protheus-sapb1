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

export async function POST(request: Request) {
    console.log('--- Excel Upload Started ---');
    try {
        const formData = await request.formData();
        const file = formData.get('file') as File;
        const entityId = formData.get('entityId') as string;
        const dryRun = formData.get('dryRun') === 'true';

        if (!file) {
            console.error('No file found in formData');
            return NextResponse.json({ success: false, message: 'Nenhum arquivo enviado.' }, { status: 400 });
        }

        console.log(`Processing file: ${file.name} (${file.size} bytes). EntityID: ${entityId || 'none'}. DryRun: ${dryRun}`);
        const buffer = await file.arrayBuffer();
        const workbook = XLSX.read(buffer);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];

        // { defval: "" } garante que colunas com células vazias na primeira linha de dados
        // não sejam omitidas do objeto final, preservando a estrutura completa do cabeçalho.
        let rawData = XLSX.utils.sheet_to_json(worksheet, { defval: "" });
        
        if (!rawData || rawData.length === 0) {
            return NextResponse.json({ success: false, message: 'Planilha vazia ou inválida.' }, { status: 400 });
        }

        // Pega os nomes das colunas a partir da primeira linha verdadeira (cabeçalho)
        const columns = Object.keys(rawData[0] as object);

        // Pula a segunda linha da planilha (índice 0 do rawData), pois a primeira é o cabeçalho
        // e a segunda geralmente é uma linha de descrição ou exemplo. Os dados começam na linha 3.
        if (rawData.length > 0) {
            rawData = rawData.slice(1);
        }

        console.log(`Parsed ${rawData.length} rows from Excel (starting from row 3).`);

        const config = await getConfig();
        const supabase = createClient(config.supabase.url, config.supabase.key, { auth: { persistSession: false } });

        // --- 1. Identify Entity vs Ad-hoc ---
        let pgTableName = '';
        let sourcePkField: string | null = null;
        let isPersistent = false;

        if (entityId && entityId !== 'null') {
            const { data: entity, error: entityErr } = await supabase
                .from('migration_entities')
                .select('*')
                .eq('id', entityId)
                .single();

            if (entityErr || !entity) {
                console.warn('Entity not found, falling back to ad-hoc migration.');
            } else {
                pgTableName = entity.staging_table;
                if (!pgTableName) {
                    pgTableName = `stg_${entity.target_object.toLowerCase()}_${entity.id}`;
                }
                sourcePkField = entity.source_pk_field;
                isPersistent = true;

                // --- 2. Dynamic Structure Validation ---
                let validation = detectEntityMismatch(entity.name, entity.target_object, columns);

                // Bypass temporário: ignora validação para Parceiros de Negócio (pedido do usuário)
                if (entity.target_object === 'BusinessPartners') {
                    validation = { mismatch: false };
                }

                if (validation.mismatch) {
                    const msg = validation.expectedObject
                        ? `O arquivo enviado parece ser de '${validation.expectedObject}', mas você selecionou '${entity.name}'.`
                        : `A estrutura da planilha não corresponde aos campos esperados para '${entity.name}'. Verifique o modelo.`;

                    return NextResponse.json({
                        success: false,
                        message: msg,
                        allowTemplateDownload: true,
                        entityId
                    }, { status: 400 });
                }

                console.log(`Using persistent staging table: ${pgTableName} (Entity: ${entity.name})`);

                // Update source file path and staging_table IF VALID and dryRun
                if (dryRun) {
                    const updatePayload: any = { source_file_path: file.name };
                    if (!entity.staging_table) {
                        updatePayload.staging_table = pgTableName;
                    }
                    await supabase
                        .from('migration_entities')
                        .update(updatePayload)
                        .eq('id', entityId);
                }
            }
        }

        const normalizeColumnName = (name: string) => {
            return name
                .toLowerCase()
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .replace(/[^a-z0-9_]/g, "_")
                .replace(/^_+|_+$/g, "");
        };

        // ── Ensure Schema Exists for Persistent Tables (Even on DryRun) ──
        if (isPersistent) {
            // Always drop the table to ensure a clean state matching the new spreadsheet structure
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
            console.log(`Verified structure for persistent table ${pgTableName}`);
            
            // Give PostgREST time to rebuild its schema cache before we try to insert
            await new Promise(r => setTimeout(r, 3000));
        }

        // Handle ad-hoc table creation
        if (!dryRun && !isPersistent) {
            const timestamp = Date.now();
            pgTableName = `excel_staging_${timestamp}`;

            // Cleanup and Create for ad-hoc
            try {
                const cleanupSql = `
                    DO $$ 
                    DECLARE r RECORD;
                    BEGIN
                        FOR r IN (SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'excel_staging_%' AND table_name !~ '^[a-zA-Z_]+_[a-zA-Z_]+$') 
                        LOOP
                            IF (EXTRACT(EPOCH FROM now()) * 1000 - CAST(substring(r.table_name from 'excel_staging_([0-9]+)') AS BIGINT)) > 3600000 THEN
                                EXECUTE 'DROP TABLE IF EXISTS "' || r.table_name || '"';
                            END IF;
                        END LOOP;
                    END $$;
                `;
                await supabase.rpc('exec_sql', { query: cleanupSql });
            } catch (ce: any) { console.warn('Cleanup warning:', ce.message); }

            const colDefs = columns.map((c: string) => `"${normalizeColumnName(c)}" text`).join(', ');
            const createSql = `
                CREATE TABLE "${pgTableName}" (id bigint primary key generated always as identity, ${colDefs}, d_e_l_e_t_ text default '');
            `;
            const { error: createErr } = await supabase.rpc('exec_sql', { query: createSql });
            if (createErr) {
                console.error('Create table error:', createErr.message);
                return NextResponse.json({ success: false, message: 'Erro ao criar tabela de staging: ' + createErr.message }, { status: 500 });
            }
            await supabase.rpc('exec_sql', { query: "NOTIFY pgrst, 'reload schema';" });
            console.log(`Created ad-hoc table ${pgTableName}`);
            await new Promise(r => setTimeout(r, 3000));
        }

        const shouldInsertData = isPersistent || !dryRun;
        let inserted = 0;

        if (shouldInsertData) {
            // Process rows
            const processedRows = rawData.map((row: any) => {
                const newRow: any = {};
                for (const key in row) {
                    newRow[normalizeColumnName(key)] = String(row[key] ?? '').trim();
                }
                // If persistent, set the source key for UPSERT
                if (isPersistent && sourcePkField) {
                    const normPk = sourcePkField.toLowerCase().replace(/_/g, "");
                    let pkVal = undefined;
                    for (const k in newRow) {
                        if (k.replace(/_/g, "") === normPk) {
                            pkVal = newRow[k];
                            break;
                        }
                    }
                    if (!pkVal) pkVal = row[sourcePkField] || row[sourcePkField.toUpperCase()];

                    if (pkVal) {
                        newRow['__source_key'] = String(pkVal).trim();
                    }
                }
                return newRow;
            });

            // Insert in batches
            const batchSize = 100;
            for (let i = 0; i < processedRows.length; i += batchSize) {
                const batch = processedRows.slice(i, i + batchSize);

                let result;
                let retryCount = 0;
                const maxRetries = 2;
                let batchSuccess = false;
                let lastBatchError: any = null;

                while (retryCount <= maxRetries && !batchSuccess) {
                    if (isPersistent && sourcePkField) {
                        result = await supabase.from(pgTableName).upsert(batch, { onConflict: '__source_key' });
                    } else {
                        result = await supabase.from(pgTableName).insert(batch);
                    }

                    if (result.error) {
                        lastBatchError = result.error;
                        console.warn(`Error in batch ${i}, retry ${retryCount}/${maxRetries}:`, result.error.message);
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
        }

        // --- Returns ---
        if (dryRun) {
            return NextResponse.json({
                success: true,
                message: `Estrutura validada com sucesso: ${rawData.length} registros e ${columns.length} colunas identificados.\nOs dados foram pré-carregados para o mapeamento.`,
                columns,
                rowCount: rawData.length,
                fileName: file.name,
                dryRun: true
            });
        }

        return NextResponse.json({
            success: true,
            message: `Sincronizacão concluída: ${inserted} registros processados em ${pgTableName}.`,
            stagingTable: pgTableName,
            isPersistent
        });

    } catch (error: any) {
        console.error('Excel Import Error:', error);
        return NextResponse.json({ success: false, message: 'Erro fatal: ' + error.message }, { status: 500 });
    }
}
