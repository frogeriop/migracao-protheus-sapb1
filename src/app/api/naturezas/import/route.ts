import { NextResponse } from 'next/server';
import sql from 'mssql';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs/promises';
import path from 'path';
import { AppConfig } from '@/types/config';

const CONFIG_FILE = path.join(process.cwd(), 'config.json');

async function getConfig(): Promise<AppConfig> {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(data);
}


/** Retorna os nomes das colunas existentes na SED010 do Protheus */
async function getProtheusColumns(pool: sql.ConnectionPool): Promise<string[]> {
    const result = await pool.request().query(`
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = 'SED010'
    `);
    return result.recordset.map((r: any) => r.COLUMN_NAME as string);
}

/** Lê schema completo (nome + tipo MSSQL) */
async function getProtheusSchema(pool: sql.ConnectionPool): Promise<Array<{ name: string; mssqlType: string; maxLen: number }>> {
    const result = await pool.request().query(`
        SELECT COLUMN_NAME, DATA_TYPE, ISNULL(CHARACTER_MAXIMUM_LENGTH, 0) AS MAX_LEN
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = 'SED010'
        ORDER BY ORDINAL_POSITION
    `);
    return result.recordset.map((r: any) => ({
        name: r.COLUMN_NAME as string,
        mssqlType: r.DATA_TYPE as string,
        maxLen: r.MAX_LEN as number,
    }));
}

/** Converte tipo MSSQL para Postgres */
function mapMssqlToPostgres(mssqlType: string): string {
    const t = mssqlType.toLowerCase();
    if (t.includes('char') || t.includes('text')) return 'text';
    if (t === 'bigint') return 'bigint';
    if (t.includes('int')) return 'integer';
    if (t === 'float' || t === 'real') return 'float8';
    if (t === 'decimal' || t === 'numeric' || t === 'money') return 'numeric';
    if (t.includes('date') || t.includes('time')) return 'timestamp';
    if (t === 'bit') return 'boolean';
    return 'text';
}

/**
 * Monta a cláusula WHERE para SED010:
 * 1. Exclui registros deletados (D_E_L_E_T_)
 * 2. Filtra apenas naturezas ANALÍTICAS: ED_TIPO = '2'
 *    (no Protheus, tipo 2 = analítico; tipos 1/3/4 = sintético/grupo)
 *    Se ED_TIPO não existir na tabela, importa tudo.
 */
function buildWhereClause(existingColsUpper: Set<string>): { sql: string; analyticalFilter: boolean } {
    const conditions: string[] = [];

    if (existingColsUpper.has('D_E_L_E_T_')) {
        conditions.push("D_E_L_E_T_ <> '*'");
    }

    const analyticalFilter = existingColsUpper.has('ED_TIPO');
    if (analyticalFilter) {
        conditions.push("LTRIM(RTRIM(ED_TIPO)) = '2'");
    }

    return {
        sql: conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '',
        analyticalFilter,
    };
}

// POST: Importar SED010 do Protheus para o Supabase
// Body: { action: 'init' | 'batch', offset?: number, limit?: number }
export async function POST(request: Request) {
    let mssqlPool: sql.ConnectionPool | null = null;

    try {
        const body = await request.json();
        const { action, offset = 0, limit = 500 } = body;

        if (!action || !['init', 'batch'].includes(action)) {
            return NextResponse.json({ success: false, message: 'action deve ser "init" ou "batch".' }, { status: 400 });
        }

        const config = await getConfig();

        if (!config.protheus || !config.supabase) {
            return NextResponse.json({ success: false, message: 'Configurações de Protheus e/ou Supabase ausentes.' }, { status: 400 });
        }

        // Conecta ao SQL Server (Protheus)
        mssqlPool = await sql.connect({
            server: config.protheus.server,
            database: config.protheus.database,
            user: config.protheus.user,
            password: config.protheus.password,
            port: Number(config.protheus.port) || 1433,
            options: { encrypt: false, trustServerCertificate: true }
        });

        // Conecta ao Supabase
        const supabase = createClient(config.supabase.url, config.supabase.key, {
            auth: { persistSession: false }
        });

        // ── INIT: DROP + CREATE (schema do MSSQL + colunas extras SAP) + conta total ──
        if (action === 'init') {
            const schema = await getProtheusSchema(mssqlPool);

            if (schema.length === 0) {
                return NextResponse.json({
                    success: false,
                    message: 'Tabela SED010 não encontrada no banco de dados Protheus.'
                });
            }

            // 1. DROP
            const dropRes = await supabase.rpc('exec_sql', { query: 'DROP TABLE IF EXISTS "sed010";' });
            if (dropRes.error) return NextResponse.json({ success: false, message: `DROP falhou: ${dropRes.error.message}` });

            // 2. CREATE com colunas do Protheus + colunas customizadas SAP
            const colDefs = schema.map(c => `"${c.name.toLowerCase()}" ${mapMssqlToPostgres(c.mssqlType)}`);
            colDefs.push('sap_account_code text');
            colDefs.push('sap_account_name text');
            colDefs.push('imported_at timestamp');
            colDefs.push('updated_at timestamp');
            const createSql = `CREATE TABLE "sed010" (${colDefs.join(', ')});`;
            const createRes = await supabase.rpc('exec_sql', { query: createSql });
            if (createRes.error) return NextResponse.json({ success: false, message: `CREATE falhou: ${createRes.error.message}` });

            // 3. Conta apenas as naturezas ANALÍTICAS no Protheus
            const existingCols = new Set(schema.map(c => c.name.toUpperCase()));
            const { sql: whereClause, analyticalFilter } = buildWhereClause(existingCols);
            const countResult = await mssqlPool.request().query(`SELECT COUNT(*) as total FROM SED010 ${whereClause}`);
            const totalRows = countResult.recordset[0].total;

            return NextResponse.json({
                success: true,
                message: analyticalFilter
                    ? 'Tabela recriada. Importando apenas naturezas analíticas.'
                    : 'Tabela recriada. Pronto para importar (ED_PAI não encontrado — sem filtro analítico).',
                totalRows,
                analyticalFilter,
            });
        }

        // ── BATCH: Copia um lote — TODOS os campos do Protheus ──────────────
        if (action === 'batch') {
            const existingCols = await getProtheusColumns(mssqlPool);
            const existingSet = new Set(existingCols.map(c => c.toUpperCase()));

            if (existingCols.length === 0) {
                return NextResponse.json({ success: false, message: 'Nenhuma coluna encontrada na SED010.' });
            }

            const { sql: whereClause } = buildWhereClause(existingSet);
            // Ordena por R_E_C_N_O_ (chave física do Protheus) para paginação estável
            const orderByCol = existingSet.has('R_E_C_N_O_') ? 'R_E_C_N_O_' : existingCols[0];

            const batchQuery = `
                SELECT *
                FROM SED010
                ${whereClause}
                ORDER BY ${orderByCol}
                OFFSET ${offset} ROWS
                FETCH NEXT ${limit} ROWS ONLY
            `;

            const batchResult = await mssqlPool.request().query(batchQuery);
            const rows = batchResult.recordset;

            if (rows.length === 0) {
                return NextResponse.json({ success: true, rowsCopied: 0, message: 'Nenhum registro neste lote.' });
            }

            // Normaliza: lowercase + trim de strings, preserva números e null
            const supabaseRows = rows.map((row: any) => {
                const normalized: any = { imported_at: new Date().toISOString() };
                for (const key of Object.keys(row)) {
                    const val = row[key];
                    normalized[key.toLowerCase()] =
                        typeof val === 'string' ? val.trim() : val ?? null;
                }
                return normalized;
            });

            // INSERT — tabela foi limpa no init, sem conflitos
            const { error } = await supabase
                .from('sed010')
                .insert(supabaseRows);

            if (error) {
                return NextResponse.json({ success: false, message: error.message });
            }

            return NextResponse.json({
                success: true,
                rowsCopied: rows.length
            });
        }

        return NextResponse.json({ success: false, message: 'Ação inválida.' }, { status: 400 });

    } catch (error: any) {
        console.error('[naturezas/import] Error:', error);
        return NextResponse.json({
            success: false,
            message: 'Erro na importação: ' + error.message
        }, { status: 500 });
    } finally {
        if (mssqlPool) await mssqlPool.close();
    }
}
