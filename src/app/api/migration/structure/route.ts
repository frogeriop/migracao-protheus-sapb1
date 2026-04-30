import { NextResponse } from 'next/server';
import sql from 'mssql';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs/promises';
import path from 'path';
import { AppConfig } from '@/types/config';

// Load config helper
const CONFIG_FILE = path.join(process.cwd(), 'config.json');
async function getConfig(): Promise<AppConfig> {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(data);
}

// Map MSSQL types to Postgres types
function mapMssqlToPostgres(mssqlType: string, length: number): string {
    const type = mssqlType.toLowerCase();

    if (type.includes('char')) return 'text';
    if (type.includes('varchar')) return 'text';
    if (type.includes('nvarchar')) return 'text';
    if (type.includes('text')) return 'text';

    if (type.includes('int')) return 'integer';
    if (type.includes('smallint')) return 'smallint';
    if (type.includes('bigint')) return 'bigint';

    if (type.includes('float')) return 'float8';
    if (type.includes('real')) return 'float4';
    if (type.includes('decimal') || type.includes('numeric')) return 'numeric';
    if (type.includes('money')) return 'numeric';

    if (type.includes('date')) return 'date';
    if (type.includes('datetime')) return 'timestamp';
    if (type.includes('smalldatetime')) return 'timestamp';

    if (type.includes('bit')) return 'boolean';

    return 'text';
}

/** Escape para literais em SQL Server (aspas simples). */
function sqlStringLiteral(value: string): string {
    return "'" + value.replace(/'/g, "''") + "'";
}

/** Lista de códigos a partir de texto (vírgula ou quebra de linha). */
function parseCommaSeparatedCodes(raw: string | undefined): string[] {
    if (!raw?.trim()) return [];
    return raw
        .split(/[,\n;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
}

/** Converte YYYY-MM-DD ou YYYYMMDD para 8 caracteres; inválido retorna null. */
function toProtheusDate8(raw: string | undefined): string | null {
    if (!raw?.trim()) return null;
    const t = raw.trim();
    if (/^\d{8}$/.test(t)) return t;
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t.replace(/-/g, '');
    return null;
}

// Helper to build WHERE clause
function buildWhereClause(tableName: string, columns: string[], filters?: any): string {
    const conditions = [];

    // 1. Standard Delete Filter
    if (columns.includes('D_E_L_E_T_')) {
        conditions.push("D_E_L_E_T_ <> '*'");
    }

    // 2. Specific Table Filters for SE1010 and SE2010
    const upperTable = tableName.toUpperCase();

    if (upperTable === 'SE1010') {
        if (columns.includes('E1_SALDO')) conditions.push("E1_SALDO > 0");
        if (columns.includes('E1_TIPO')) conditions.push("E1_TIPO NOT LIKE '%-%'");
        // Filtra apenas a filial 01
        if (columns.includes('E1_FILIAL')) conditions.push("E1_FILIAL = '01'");
    }

    if (upperTable === 'SE2010') {
        if (columns.includes('E2_SALDO')) conditions.push("E2_SALDO > 0");
        if (columns.includes('E2_TIPO')) conditions.push("E2_TIPO NOT LIKE '%-%'");
    }

    // 2b. Filtros opcionais do usuário (AND sobre os fixos de SE1010 / SE2010)
    if (upperTable === 'SE1010') {
        const f = filters?.se1010;
        if (f?.tipo?.trim() && columns.includes('E1_TIPO')) {
            conditions.push(`E1_TIPO = ${sqlStringLiteral(f.tipo.trim())}`);
        }
        if (f?.xtipo?.trim() && columns.includes('E1_XTIPO')) {
            conditions.push(`E1_XTIPO = ${sqlStringLiteral(f.xtipo.trim())}`);
        }
        if (f?.xtpparc?.trim() && columns.includes('E1_XTPPARC')) {
            conditions.push(`E1_XTPPARC = ${sqlStringLiteral(f.xtpparc.trim())}`);
        }
        const e1emiDe = toProtheusDate8(f?.emissaoDe);
        const e1emiAte = toProtheusDate8(f?.emissaoAte);
        const e1venDe = toProtheusDate8(f?.vencreaDe);
        const e1venAte = toProtheusDate8(f?.vencreaAte);
        if (e1emiDe && columns.includes('E1_EMISSAO')) conditions.push(`E1_EMISSAO >= ${sqlStringLiteral(e1emiDe)}`);
        if (e1emiAte && columns.includes('E1_EMISSAO')) conditions.push(`E1_EMISSAO <= ${sqlStringLiteral(e1emiAte)}`);
        if (e1venDe && columns.includes('E1_VENCREA')) conditions.push(`E1_VENCREA >= ${sqlStringLiteral(e1venDe)}`);
        if (e1venAte && columns.includes('E1_VENCREA')) conditions.push(`E1_VENCREA <= ${sqlStringLiteral(e1venAte)}`);
        const e1Clientes = parseCommaSeparatedCodes(f?.codigoCliente);
        if (e1Clientes.length === 1 && columns.includes('E1_CLIENTE')) {
            conditions.push(`E1_CLIENTE = ${sqlStringLiteral(e1Clientes[0])}`);
        } else if (e1Clientes.length > 1 && columns.includes('E1_CLIENTE')) {
            conditions.push(
                `E1_CLIENTE IN (${e1Clientes.map((c) => sqlStringLiteral(c)).join(', ')})`
            );
        }
        const notaMode = f?.notaJaEmitida ?? 'nao';
        if (columns.includes('E1_XNUMNFS')) {
            if (notaMode === 'sim') {
                conditions.push('(E1_XNUMNFS IS NOT NULL AND LTRIM(RTRIM(E1_XNUMNFS)) <> \'\')');
            } else {
                conditions.push('(E1_XNUMNFS IS NULL OR LTRIM(RTRIM(E1_XNUMNFS)) = \'\')');
            }
        }
    }
    if (upperTable === 'SE2010') {
        const f = filters?.se2010;
        if (f?.tipo?.trim() && columns.includes('E2_TIPO')) {
            conditions.push(`E2_TIPO = ${sqlStringLiteral(f.tipo.trim())}`);
        }
        if (f?.xtipo?.trim() && columns.includes('E2_XTIPO')) {
            conditions.push(`E2_XTIPO = ${sqlStringLiteral(f.xtipo.trim())}`);
        }
        if (f?.xtpparc?.trim() && columns.includes('E2_XTPPARC')) {
            conditions.push(`E2_XTPPARC = ${sqlStringLiteral(f.xtpparc.trim())}`);
        }
        const e2emiDe = toProtheusDate8(f?.emissaoDe);
        const e2emiAte = toProtheusDate8(f?.emissaoAte);
        const e2venDe = toProtheusDate8(f?.vencreaDe);
        const e2venAte = toProtheusDate8(f?.vencreaAte);
        if (e2emiDe && columns.includes('E2_EMISSAO')) conditions.push(`E2_EMISSAO >= ${sqlStringLiteral(e2emiDe)}`);
        if (e2emiAte && columns.includes('E2_EMISSAO')) conditions.push(`E2_EMISSAO <= ${sqlStringLiteral(e2emiAte)}`);
        if (e2venDe && columns.includes('E2_VENCREA')) conditions.push(`E2_VENCREA >= ${sqlStringLiteral(e2venDe)}`);
        if (e2venAte && columns.includes('E2_VENCREA')) conditions.push(`E2_VENCREA <= ${sqlStringLiteral(e2venAte)}`);
        const e2Fornec = parseCommaSeparatedCodes(f?.codigoFornecedor);
        if (e2Fornec.length === 1 && columns.includes('E2_FORNECE')) {
            conditions.push(`E2_FORNECE = ${sqlStringLiteral(e2Fornec[0])}`);
        } else if (e2Fornec.length > 1 && columns.includes('E2_FORNECE')) {
            conditions.push(
                `E2_FORNECE IN (${e2Fornec.map((c) => sqlStringLiteral(c)).join(', ')})`
            );
        }
    }

    // 3. Filters for Blocked/Inactive (MSBLQL)
    if (upperTable === 'SU5010' && columns.includes('U5_MSBLQL')) {
        const pStatus = filters?.su5010?.status || 'active';
        if (pStatus === 'active') conditions.push("U5_MSBLQL = '2'");
        else if (pStatus === 'inactive') conditions.push("U5_MSBLQL = '1'");
    }

    // SU5010: não importar contatos sem cliente vinculado (padrão Totvs: U5_CLIENTE; alguns ambientes usam alias E5_CLIENTE)
    if (upperTable === 'SU5010') {
        if (columns.includes('U5_CLIENTE')) {
            conditions.push(
                '(U5_CLIENTE IS NOT NULL AND LTRIM(RTRIM(U5_CLIENTE)) <> \'\')'
            );
        } else if (columns.includes('E5_CLIENTE')) {
            conditions.push(
                '(E5_CLIENTE IS NOT NULL AND LTRIM(RTRIM(E5_CLIENTE)) <> \'\')'
            );
        }
    }

    if (upperTable === 'SA1010' && columns.includes('A1_MSBLQL')) {
        const pStatus = filters?.sa1010?.status || 'active';
        if (pStatus === 'active') conditions.push("A1_MSBLQL = '2'");
        else if (pStatus === 'inactive') conditions.push("A1_MSBLQL = '1'");
    }
    if (upperTable === 'SA2010' && columns.includes('A2_MSBLQL')) {
        const pStatus = filters?.sa2010?.status || 'active';
        if (pStatus === 'active') conditions.push("A2_MSBLQL = '2'");
        else if (pStatus === 'inactive') conditions.push("A2_MSBLQL = '1'");
    }
    if (upperTable === 'SB1010' && columns.includes('B1_MSBLQL')) {
        conditions.push("B1_MSBLQL = '2'");
    }

    // 4. Saldo em Aberto para SA1 e SA2
    if (upperTable === 'SA1010') {
        const pBalance = filters?.sa1010?.balance || 'all';
        if (pBalance === 'open') {
            conditions.push(`EXISTS (
                SELECT 1 FROM SE1010 SE1 
                WHERE SE1.E1_CLIENTE = ${tableName}.A1_COD 
                  AND SE1.E1_LOJA = ${tableName}.A1_LOJA 
                  AND SE1.E1_SALDO > 0 
                  AND SE1.E1_TIPO NOT LIKE '%-%' 
                  AND SE1.D_E_L_E_T_ <> '*'
            )`);
        }
    }
    if (upperTable === 'SA2010') {
        const pBalance = filters?.sa2010?.balance || 'all';
        if (pBalance === 'open') {
            conditions.push(`EXISTS (
                SELECT 1 FROM SE2010 SE2 
                WHERE SE2.E2_FORNECE = ${tableName}.A2_COD 
                  AND SE2.E2_LOJA = ${tableName}.A2_LOJA 
                  AND SE2.E2_SALDO > 0 
                  AND SE2.E2_TIPO NOT LIKE '%-%' 
                  AND SE2.D_E_L_E_T_ <> '*'
            )`);
        }
    }

    // Filter for SED010: active nature records with valid code
    if (upperTable === 'SED010' && columns.includes('ED_CODIGO')) {
        conditions.push("ED_CODIGO <> ''");
    }

    if (conditions.length === 0) return "";
    return "WHERE " + conditions.join(" AND ");
}

/**
 * Colunas extras de integracão com o SAP que devem ser preservadas
 * mesmo após reimportacão (DROP + CREATE) das tabelas do TOTVS.
 * Formato: { pgColumnName: pgType }
 */
const SAP_EXTRA_COLUMNS: Record<string, Record<string, string>> = {
    se2010: { __sap_id: 'text' },
    se1010: { __sap_id: 'text' },
    sa1010: { __sap_id: 'text' },
    sa2010: { __sap_id: 'text' },
    sb1010: { __sap_id: 'text' },
    su5010: { __sap_id: 'text' },
    sed010: { sap_account_code: 'text', sap_account_name: 'text' },
};

/**
 * Garante que as colunas SAP extras existam na tabela PG,
 * preservando dados já gravados por write-back.
 */
async function ensureSapColumns(
    supabase: any,
    pgTableName: string
): Promise<void> {
    const extras = SAP_EXTRA_COLUMNS[pgTableName.toLowerCase()];
    if (!extras) return;
    for (const [col, pgType] of Object.entries(extras)) {
        const alterSql = `ALTER TABLE "${pgTableName}" ADD COLUMN IF NOT EXISTS "${col}" ${pgType};`;
        const { error } = await supabase.rpc('exec_sql', { query: alterSql });
        if (error) {
            console.warn(`[structure] ensureSapColumns: não foi possível adicionar ${col} em ${pgTableName}:`, error.message);
        }
    }
}

export async function POST(request: Request) {
    let mssqlPool = null;

    try {
        const body = await request.json();
        const { action, tableName, offset, limit, filters } = body;
        // action: 'init' | 'batch' | 'sync_sap'

        if (!tableName) {
            return NextResponse.json({ success: false, message: 'Nome da tabela não fornecido.' }, { status: 400 });
        }

        const config = await getConfig();

        if (!config.protheus || !config.supabase) {
            return NextResponse.json({ success: false, message: 'Configurações ausentes.' }, { status: 400 });
        }

        // --- ACTION: SYNC_SAP (Populate __sap_id after import) ---
        // Does NOT need SQL Server connection — only Supabase + SAP Service Layer.
        if (action === 'sync_sap') {
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
            const supabase = createClient(config.supabase.url, config.supabase.key, { auth: { persistSession: false } });
            const upper = tableName.toUpperCase();

            // ── SAP Login ────────────────────────────────────────────────────────
            const loginRes = await fetch(`${config.sap.serviceLayerUrl}/Login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ CompanyDB: config.sap.companyDB, UserName: config.sap.userName, Password: config.sap.password }),
            });
            if (!loginRes.ok) {
                return NextResponse.json({ success: false, message: 'SAP Login falhou — __sap_id não sincronizado.' });
            }
            const cookies = loginRes.headers.get('set-cookie') || '';

            // Retorna um ReadableStream NDJSON para progresso em tempo real
            // Cada linha é um JSON: { progress: string } ou { success, updated, skipped, message }
            const enc = new TextEncoder();
            const stream = new ReadableStream({
                async start(controller) {
                    const send = (obj: object) =>
                        controller.enqueue(enc.encode(JSON.stringify(obj) + '\n'));

                    const PAGE_SIZE = 200;
                    let updated = 0, skipped = 0;

                    try {
                        // ── SA1010 / SA2010: cruza por CNPJ ↔ FederalTaxID ──────────────
                        if (upper === 'SA1010' || upper === 'SA2010') {
                            const pgTable = upper.toLowerCase();
                            const pkField = upper === 'SA1010' ? 'a1_cod' : 'a2_cod';
                            const cgcField = upper === 'SA1010' ? 'a1_cgc' : 'a2_cgc';
                            const cardType = upper === 'SA1010' ? 'C' : 'S';
                            const label = upper === 'SA1010' ? 'Clientes' : 'Fornecedores';

                            // 1. Busca todos os BPs do SAP paginando até o fim
                            send({ progress: `🔗 Buscando ${label} no SAP B1 (pág. 1)...` });
                            const cnpjToCardCode: Record<string, string> = {};
                            let skip = 0, hasMore = true, page = 1;
                            while (hasMore) {
                                const filter = encodeURIComponent(`CardType eq '${cardType}'`);
                                const r = await fetch(
                                    `${config.sap.serviceLayerUrl}/BusinessPartners?$select=CardCode,FederalTaxID&$filter=${filter}&$skip=${skip}&$top=${PAGE_SIZE}`,
                                    { headers: { Cookie: cookies, Prefer: `odata.maxpagesize=${PAGE_SIZE}` } }
                                );
                                if (!r.ok) { send({ progress: `⚠️ SAP retornou erro ${r.status} na pág. ${page}.` }); break; }
                                const j: { value?: any[] } = await r.json();
                                const bps = j.value || [];
                                for (const bp of bps) {
                                    if (bp.FederalTaxID) {
                                        const norm = String(bp.FederalTaxID).replace(/\D/g, '');
                                        if (norm) cnpjToCardCode[norm] = bp.CardCode;
                                    }
                                }
                                hasMore = bps.length === PAGE_SIZE;
                                skip += PAGE_SIZE;
                                page++;
                                if (hasMore) send({ progress: `🔗 Buscando ${label} no SAP B1 (pág. ${page})...` });
                            }
                            send({ progress: `📋 SAP: ${Object.keys(cnpjToCardCode).length} ${label} com CNPJ encontrados. Processando cadastro local...` });

                            // 2. Processa TODO o cadastro local paginando pelo Supabase
                            let supabaseOffset = 0;
                            const SUPA_PAGE = 1000;
                            while (true) {
                                const { data: rows, error: rowsErr } = await supabase
                                    .from(pgTable)
                                    .select(`${pkField}, ${cgcField}, __sap_id`)
                                    .eq('d_e_l_e_t_', '')
                                    .range(supabaseOffset, supabaseOffset + SUPA_PAGE - 1);

                                if (rowsErr || !rows || rows.length === 0) break;

                                send({ progress: `🔄 Processando registros ${supabaseOffset + 1}–${supabaseOffset + rows.length}...` });

                                for (const row of (rows as any[])) {
                                    const cgcNorm = String(row[cgcField] ?? '').replace(/\D/g, '');
                                    if (!cgcNorm) { skipped++; continue; }
                                    const cardCode = cnpjToCardCode[cgcNorm];
                                    if (cardCode) {
                                        if (row.__sap_id !== cardCode) {
                                            await supabase.from(pgTable).update({ __sap_id: cardCode }).eq(pkField, row[pkField]);
                                        }
                                        updated++;
                                    } else {
                                        skipped++;
                                    }
                                }

                                if (rows.length < SUPA_PAGE) break;
                                supabaseOffset += SUPA_PAGE;
                            }

                            send({
                                success: true, updated, skipped,
                                message: `✅ ${updated} __sap_id sincronizados, ${skipped} não encontrados no SAP.`,
                            });
                            return;
                        }

                        // ── SE1010 / SE2010: cruza por Reference2 ↔ sap_jdt_num ─────────
                        if (upper === 'SE1010' || upper === 'SE2010') {
                            const pgTable = upper.toLowerCase();
                            const sapObject = upper === 'SE1010' ? 'Invoices' : 'JournalEntries';
                            const label = upper === 'SE1010' ? 'Contas a Receber' : 'Contas a Pagar';
                            const keyFields = upper === 'SE2010'
                                ? ['e2_fornece', 'e2_prefixo', 'e2_num', 'e2_parcela', 'e2_tipo']
                                : ['e1_cliente', 'e1_prefixo', 'e1_num', 'e1_parcela', 'e1_tipo'];

                            send({ progress: `📂 Carregando ${label} do banco local...` });

                            let supabaseOffset = 0;
                            const SUPA_PAGE = 500;

                            while (true) {
                                const { data: rows, error: rowsErr } = await supabase
                                    .from(pgTable)
                                    .select(`r_e_c_n_o_, ${keyFields.join(', ')}, __sap_id`)
                                    .eq('d_e_l_e_t_', '')
                                    .range(supabaseOffset, supabaseOffset + SUPA_PAGE - 1);

                                if (rowsErr || !rows || rows.length === 0) break;

                                send({ progress: `🔍 Pesquisando no SAP: registros ${supabaseOffset + 1}–${supabaseOffset + rows.length} de ${label}...` });

                                for (const row of (rows as any[])) {
                                    if (row.__sap_id) { updated++; continue; }
                                    const parts = keyFields.map((f: string) => String(row[f] ?? '').trim()).filter(Boolean);
                                    const ref2 = parts.join('/').slice(0, 100);
                                    if (!ref2) { skipped++; continue; }

                                    try {
                                        const filter = encodeURIComponent(`Reference2 eq '${ref2.replace(/'/g, "''")}'`);
                                        const r = await fetch(
                                            `${config.sap.serviceLayerUrl}/${sapObject}?$select=JdtNum,Reference2&$filter=${filter}&$top=1`,
                                            { headers: { Cookie: cookies } }
                                        );
                                        if (r.ok) {
                                            const j: { value?: any[] } = await r.json();
                                            const jdtNum = j.value?.[0]?.JdtNum;
                                            if (jdtNum) {
                                                await supabase.from(pgTable).update({ __sap_id: String(jdtNum) }).eq('r_e_c_n_o_', row.r_e_c_n_o_);
                                                updated++;
                                                send({ progress: `✅ ${ref2} → JdtNum ${jdtNum} (${updated} sincronizados)` });
                                            } else {
                                                skipped++;
                                            }
                                        }
                                    } catch { skipped++; }
                                }

                                if (rows.length < SUPA_PAGE) break;
                                supabaseOffset += SUPA_PAGE;
                            }

                            send({
                                success: true, updated, skipped,
                                message: `✅ ${updated} __sap_id sincronizados, ${skipped} não encontrados no SAP.`,
                            });
                            return;
                        }

                        send({ success: false, message: `sync_sap não implementado para ${tableName}.` });
                    } catch (err: any) {
                        send({ success: false, message: `Erro: ${err.message}` });
                    } finally {
                        controller.close();
                    }
                }
            });

            return new Response(stream, {
                headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
            });
        }
        // SQL Server only needed for init/batch actions below
        // 1. Connect to Protheus
        mssqlPool = await sql.connect({
            server: config.protheus.server,
            database: config.protheus.database,
            user: config.protheus.user,
            password: config.protheus.password,
            port: Number(config.protheus.port) || 1433,
            options: { encrypt: false, trustServerCertificate: true }
        });

        // 2. Connect to Supabase
        const supabase = createClient(config.supabase.url, config.supabase.key, {
            auth: { persistSession: false }
        });

        const pgTableName = tableName.toLowerCase();

        // --- ACTION: INIT (Create Structure & Count) ---
        if (action === 'init') {
            // Read Structure
            const queryStruct = `
        SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = '${tableName}'
        `;
            const colResult = await mssqlPool.request().query(queryStruct);

            if (colResult.recordset.length === 0) {
                return NextResponse.json({ success: false, message: `Tabela ${tableName} não encontrada na origem.` });
            }

            // CREATE TABLE Logic
            let createSql = `create table if not exists "${pgTableName}" (`;
            const colDefs = [];
            const sourceColumns = [];

            for (const col of colResult.recordset) {
                const pgType = mapMssqlToPostgres(col.DATA_TYPE, col.CHARACTER_MAXIMUM_LENGTH);
                const colName = col.COLUMN_NAME.toLowerCase();
                colDefs.push(`"${colName}" ${pgType}`);
                sourceColumns.push(col.COLUMN_NAME);
            }
            createSql += colDefs.join(', ') + ');';

            // DROP check
            const dropSql = `DROP TABLE IF EXISTS "${pgTableName}";`;
            const dropRes = await supabase.rpc('exec_sql', { query: dropSql });
            if (dropRes.error) {
                return NextResponse.json({ success: false, message: `Erro ao remover tabela antiga: ${dropRes.error.message}` });
            }

            // EXECUTE CREATE
            const createRes = await supabase.rpc('exec_sql', { query: createSql });
            if (createRes.error) {
                return NextResponse.json({ success: false, message: `Erro ao criar estrutura: ${createRes.error.message}` });
            }

            // ── Recriar colunas de integração SAP (preservadas mesmo após DROP+CREATE) ──
            await ensureSapColumns(supabase, pgTableName);

            // Count Total Active Rows with Filters
            const sourceColNames = colResult.recordset.map((c: any) => c.COLUMN_NAME);
            const whereClause = buildWhereClause(tableName, sourceColNames, filters);
            const countRes = await mssqlPool.request().query(`SELECT COUNT(*) as total FROM ${tableName} ${whereClause}`);
            const totalRows = countRes.recordset[0].total;

            return NextResponse.json({
                success: true,
                message: 'Estrutura criada e contagem realizada.',
                totalRows: totalRows
            });
        }

        // --- ACTION: PREVIEW (Fetch 5 rows) ---
        if (action === 'preview') {
            const queryStruct = `
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = '${tableName}'
        `;
            const colResult = await mssqlPool.request().query(queryStruct);
            const sourceColumns = colResult.recordset.map((c: any) => c.COLUMN_NAME);

            // Apply Filters
            const whereClause = buildWhereClause(tableName, sourceColumns, filters);

            // Pagination Order
            const orderByCol = sourceColumns.includes('R_E_C_N_O_') ? 'R_E_C_N_O_' : sourceColumns[0];

            const previewQuery = `
            SELECT ${sourceColumns.join(', ')}
            FROM ${tableName}
            ${whereClause}
            ORDER BY ${orderByCol}
            OFFSET 0 ROWS
            FETCH NEXT 5 ROWS ONLY
        `;

            const previewResult = await mssqlPool.request().query(previewQuery);
            const rows = previewResult.recordset;

            const lowerRows = rows.map((row: any) => {
                const newRow: any = {};
                for (const key in row) {
                    let val = row[key];
                    if (typeof val === 'string') val = val.trim();
                    newRow[key.toLowerCase()] = val;
                }
                return newRow;
            });

            return NextResponse.json({
                success: true,
                data: lowerRows
            });
        }

        // --- ACTION: PATCH_COLUMNS (Sync specific columns from Protheus → Supabase) ---
        // Use case: a new column was added to Supabase after the initial import.
        // Body: { action: 'patch_columns', tableName: 'SA1010', columns: ['A1_PRIME', 'A1_HRSUPO'] }
        if (action === 'patch_columns') {
            const { columns: colsToSync } = body as { columns?: string[] };
            if (!colsToSync || colsToSync.length === 0) {
                return NextResponse.json({ success: false, message: 'Informe os campos a sincronizar em "columns".' }, { status: 400 });
            }

            const upperCols = colsToSync.map(c => c.toUpperCase());
            const selectCols = ['R_E_C_N_O_', ...upperCols];

            const BATCH_SIZE = 500;
            let offset = 0;
            let totalUpdated = 0;

            // Count source rows
            const countRes = await mssqlPool.request().query(`SELECT COUNT(*) as total FROM ${tableName} WHERE D_E_L_E_T_ <> '*'`);
            const totalRows: number = countRes.recordset[0].total;

            while (offset < totalRows) {
                const batchQuery = `
                    SELECT ${selectCols.join(', ')}
                    FROM ${tableName}
                    WHERE D_E_L_E_T_ <> '*'
                    ORDER BY R_E_C_N_O_
                    OFFSET ${offset} ROWS
                    FETCH NEXT ${BATCH_SIZE} ROWS ONLY
                `;
                const batchResult = await mssqlPool.request().query(batchQuery);
                const rows = batchResult.recordset;
                if (rows.length === 0) break;

                // Build upsert payload — only r_e_c_n_o_ + synced columns
                const upsertRows = rows.map((row: any) => {
                    const obj: Record<string, any> = { r_e_c_n_o_: row['R_E_C_N_O_'] };
                    for (const col of colsToSync) {
                        let val = row[col.toUpperCase()];
                        if (typeof val === 'string') val = val.trim();
                        obj[col.toLowerCase()] = val ?? null;
                    }
                    return obj;
                });

                // Upsert on r_e_c_n_o_ — updates only the specified columns, leaves others intact
                const { error: upsertErr } = await supabase
                    .from(pgTableName)
                    .upsert(upsertRows, { onConflict: 'r_e_c_n_o_', ignoreDuplicates: false });

                if (upsertErr) {
                    console.error('[patch_columns] upsert error:', upsertErr.message);
                } else {
                    totalUpdated += rows.length;
                }

                offset += BATCH_SIZE;
            }

            return NextResponse.json({
                success: true,
                message: `${totalUpdated} de ${totalRows} registros sincronizados com os campos: ${colsToSync.join(', ')}`,
                totalUpdated,
                totalRows,
            });
        }

        // --- ACTION: BATCH (Copy Data) ---
        if (action === 'batch') {
            const batchLimit = limit || 1000;
            const batchOffset = offset || 0;

            const queryStruct = `
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = '${tableName}'
        `;
            const colResult = await mssqlPool.request().query(queryStruct);
            const sourceColumns = colResult.recordset.map((c: any) => c.COLUMN_NAME);

            // Apply Filters
            const whereClause = buildWhereClause(tableName, sourceColumns, filters);

            // Pagination Order
            const orderByCol = sourceColumns.includes('R_E_C_N_O_') ? 'R_E_C_N_O_' : sourceColumns[0];

            const batchQuery = `
            SELECT ${sourceColumns.join(', ')}
            FROM ${tableName}
            ${whereClause}
            ORDER BY ${orderByCol}
            OFFSET ${batchOffset} ROWS
            FETCH NEXT ${batchLimit} ROWS ONLY
        `;

            const batchResult = await mssqlPool.request().query(batchQuery);
            const rows = batchResult.recordset;

            if (rows.length > 0) {
                const lowerRows = rows.map(row => {
                    const newRow: any = {};
                    for (const key in row) {
                        let val = row[key];
                        if (typeof val === 'string') val = val.trim();
                        newRow[key.toLowerCase()] = val;
                    }
                    return newRow;
                });

                const insertRes = await supabase.from(pgTableName).insert(lowerRows);
                if (insertRes.error) {
                    return NextResponse.json({ success: false, message: insertRes.error.message });
                }
            }

            return NextResponse.json({
                success: true,
                rowsCopied: rows.length
            });
        }

        return NextResponse.json({ success: false, message: 'Ação inválida.' }, { status: 400 });

    } catch (error: any) {
        console.error('Migration API Error:', error);
        return NextResponse.json({
            success: false,
            message: 'Erro fatal: ' + error.message
        }, { status: 500 });
    } finally {
        if (mssqlPool) await mssqlPool.close();
    }
}
