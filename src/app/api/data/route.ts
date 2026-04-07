import { NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import fs from 'fs/promises';
import path from 'path';
import { AppConfig } from '@/types/config';

const CONFIG_FILE = path.join(process.cwd(), 'config.json');

async function getConfig(): Promise<AppConfig> {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(data);
}

// Colunas de busca por tabela (busca na tabela INTEIRA via PostgREST — WHERE é aplicado antes do LIMIT/OFFSET)
const SEARCH_COLUMNS: Record<string, string[]> = {
    sa1010: ['a1_cod', 'a1_nome', 'a1_nreduz', 'a1_cgc'],
    sa2010: ['a2_cod', 'a2_nome', 'a2_nreduz', 'a2_cgc'],
    su5010: ['u5_codcont', 'u5_cliente', 'u5_loja', 'u5_contat', 'u5_email', 'u5_fcom1', 'u5_dfuncao'],
    sb1010: ['b1_cod', 'b1_desc'],
    se1010: ['e1_num', 'e1_cliente', 'e1_nomcli', 'e1_prefixo', 'e1_tipo'],
    se2010: ['e2_num', 'e2_fornece', 'e2_nomfor', 'e2_prefixo', 'e2_tipo'],
    sed010: ['ed_codigo', 'ed_descric', 'ed_conta', 'sap_account_code', 'sap_account_name'],
    sap_chart_of_accounts: ['code', 'name', 'account_type', 'father_account'],
    sap_cost_centers: ['code', 'name'],
};

/**
 * Número do título (SE1/SE2). PostgREST rejeita `cast(col,text).ilike` dentro de `.or()` (erro de parse).
 * - Busca só dígitos (ex.: 000047156): usa `eq` (funciona em texto ou numérico).
 * - Demais buscas: `ilike` se não for só dígitos (substring em colunas texto); só dígitos já coberto por eq.
 */
const TITLE_NUM_FIELDS = new Set(['e1_num', 'e2_num']);

const COLUMN_FILTERS_MAX_BYTES = 8192;

const HIDDEN_FILTER_COLUMNS = new Set([
    'id', 'd_e_l_e_t_', '__source_key', '__sap_id', '__integration_status', '__sync_message', '__last_sync', 'r_e_c_n_o_',
]);

type AgGridTextCondition = { type?: string; filter?: string | null };
type AgGridTextFilterModel = {
    filterType?: string;
    type?: string;
    filter?: string | null;
    operator?: 'AND' | 'OR';
    condition1?: AgGridTextCondition;
    condition2?: AgGridTextCondition;
};

type AgGridNumberCondition = { type?: string; filter?: number | string | null };
type AgGridNumberFilterModel = {
    filterType?: string;
    type?: string;
    filter?: number | string | null;
    operator?: 'AND' | 'OR';
    condition1?: AgGridNumberCondition;
    condition2?: AgGridNumberCondition;
};

function escapeIlikePattern(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

async function fetchAllowedColumnsFromOpenApi(
    config: AppConfig,
    tableKey: string
): Promise<string[] | null> {
    try {
        const optionsRes = await fetch(`${config.supabase!.url}/rest/v1/`, {
            method: 'GET',
            headers: {
                apikey: config.supabase!.key,
                Authorization: `Bearer ${config.supabase!.key}`,
                Accept: 'application/openapi+json',
            },
        });
        if (!optionsRes.ok) return null;
        const openapi = await optionsRes.json();
        const def = openapi?.definitions?.[tableKey];
        if (!def?.properties) return null;
        return Object.keys(def.properties).filter((c) => !HIDDEN_FILTER_COLUMNS.has(c));
    } catch {
        return null;
    }
}

async function getAllowedFilterColumns(
    supabase: SupabaseClient,
    config: AppConfig,
    tableKey: string
): Promise<Set<string>> {
    const fromOpenApi = await fetchAllowedColumnsFromOpenApi(config, tableKey);
    if (fromOpenApi && fromOpenApi.length > 0) {
        return new Set(fromOpenApi);
    }
    const fallback = await supabase.from(tableKey).select('*').limit(1);
    if (fallback.data && fallback.data.length > 0) {
        return new Set(Object.keys(fallback.data[0]).filter((c) => !HIDDEN_FILTER_COLUMNS.has(c)));
    }
    return new Set();
}

function parseColumnFiltersParam(raw: string | null): { model: Record<string, unknown> | null; error?: string } {
    if (!raw || !raw.trim()) return { model: null };
    const buf = Buffer.byteLength(raw, 'utf8');
    if (buf > COLUMN_FILTERS_MAX_BYTES) {
        return { model: null, error: 'Filtros de coluna excedem o tamanho máximo permitido.' };
    }
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { model: null, error: 'columnFilters deve ser um objeto JSON.' };
        }
        return { model: parsed as Record<string, unknown> };
    } catch {
        return { model: null, error: 'columnFilters JSON inválido.' };
    }
}

/** Aplica um filtro de texto AG Grid (simples ou dois subfiltros AND/OR) num builder PostgREST. */
function applyTextColumnFilter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: any,
    col: string,
    m: AgGridTextFilterModel
): { query: any; error?: string } {
    const hasDual =
        m.operator &&
        m.condition1 &&
        m.condition2 &&
        (m.condition1.type || m.condition1.filter) &&
        (m.condition2.type || m.condition2.filter);

    if (hasDual) {
        const op = m.operator!;
        const c1 = m.condition1!;
        const c2 = m.condition2!;
        if (op === 'AND') {
            let q = query;
            const r1 = applySingleTextCondition(q, col, c1.type || 'contains', c1.filter ?? '');
            if (r1.error) return { query, error: r1.error };
            q = r1.query;
            const r2 = applySingleTextCondition(q, col, c2.type || 'contains', c2.filter ?? '');
            if (r2.error) return { query, error: r2.error };
            return { query: r2.query };
        }
        const orParts: string[] = [];
        const e1 = buildPostgrestTextOrPart(col, c1.type || 'contains', c1.filter ?? '');
        if (e1.error) return { query, error: e1.error };
        orParts.push(e1.part!);
        const e2 = buildPostgrestTextOrPart(col, c2.type || 'contains', c2.filter ?? '');
        if (e2.error) return { query, error: e2.error };
        orParts.push(e2.part!);
        return { query: query.or(orParts.join(',')) };
    }

    const type = m.type || 'contains';
    const filterVal = m.filter ?? '';
    return applySingleTextCondition(query, col, type, filterVal);
}

function buildPostgrestTextOrPart(
    col: string,
    type: string,
    filterVal: string
): { part?: string; error?: string } {
    const trimmed = String(filterVal ?? '').trim();
    if (type === 'blank' || type === 'empty') {
        return { part: `${col}.is.null,${col}.eq.` };
    }
    if (type === 'notBlank' || type === 'notEmpty') {
        return {
            error:
                'Filtro "não vazio" em combinação OR na mesma coluna não é suportado; use um único critério.',
        };
    }
    const esc = escapeIlikePattern(trimmed);
    switch (type) {
        case 'equals':
            return { part: `${col}.eq.${trimmed}` };
        case 'notEqual':
            return { part: `${col}.neq.${trimmed}` };
        case 'contains':
            return { part: `${col}.ilike.%${esc}%` };
        case 'notContains':
            return { part: `${col}.not.ilike.%${esc}%` };
        case 'startsWith':
            return { part: `${col}.ilike.${esc}%` };
        case 'endsWith':
            return { part: `${col}.ilike.%${esc}` };
        default:
            return { part: `${col}.ilike.%${esc}%` };
    }
}

function applySingleTextCondition(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: any,
    col: string,
    type: string,
    filterVal: string
): { query: any; error?: string } {
    const trimmed = String(filterVal ?? '').trim();
    if (type === 'blank' || type === 'empty') {
        return { query: query.or(`${col}.is.null,${col}.eq.`) };
    }
    if (type === 'notBlank' || type === 'notEmpty') {
        return { query: query.not(col, 'is', null).neq(col, '') };
    }
    const esc = escapeIlikePattern(trimmed);
    switch (type) {
        case 'equals':
            return { query: query.eq(col, trimmed) };
        case 'notEqual':
            return { query: query.neq(col, trimmed) };
        case 'contains':
            return { query: query.ilike(col, `%${esc}%`) };
        case 'notContains':
            return { query: query.not(col, 'ilike', `%${esc}%`) };
        case 'startsWith':
            return { query: query.ilike(col, `${esc}%`) };
        case 'endsWith':
            return { query: query.ilike(col, `%${esc}`) };
        default:
            return { query: query.ilike(col, `%${esc}%`) };
    }
}

function parseNumber(v: number | string | null | undefined): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
}

function applyNumberColumnFilter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: any,
    col: string,
    m: AgGridNumberFilterModel
): { query: any; error?: string } {
    const hasDual =
        m.operator &&
        m.condition1 &&
        m.condition2 &&
        (m.condition1.type || m.condition1.filter !== undefined) &&
        (m.condition2.type || m.condition2.filter !== undefined);

    if (hasDual) {
        const op = m.operator!;
        const c1 = m.condition1!;
        const c2 = m.condition2!;
        if (op === 'AND') {
            let q = query;
            const r1 = applySingleNumberCondition(q, col, c1.type || 'equals', c1.filter);
            if (r1.error) return { query, error: r1.error };
            q = r1.query;
            const r2 = applySingleNumberCondition(q, col, c2.type || 'equals', c2.filter);
            if (r2.error) return { query, error: r2.error };
            return { query: r2.query };
        }
        const orParts: string[] = [];
        const e1 = buildPostgrestNumberOrPart(col, c1.type || 'equals', c1.filter);
        if (e1.error) return { query, error: e1.error };
        orParts.push(e1.part!);
        const e2 = buildPostgrestNumberOrPart(col, c2.type || 'equals', c2.filter);
        if (e2.error) return { query, error: e2.error };
        orParts.push(e2.part!);
        return { query: query.or(orParts.join(',')) };
    }

    return applySingleNumberCondition(query, col, m.type || 'equals', m.filter);
}

function buildPostgrestNumberOrPart(
    col: string,
    type: string,
    filterVal: number | string | null | undefined
): { part?: string; error?: string } {
    const n = parseNumber(filterVal);
    if (n === null && type !== 'blank' && type !== 'empty' && type !== 'notBlank' && type !== 'notEmpty') {
        return { error: `Filtro numérico inválido na coluna ${col}.` };
    }
    switch (type) {
        case 'equals':
            return { part: `${col}.eq.${n}` };
        case 'notEqual':
            return { part: `${col}.neq.${n}` };
        case 'greaterThan':
            return { part: `${col}.gt.${n}` };
        case 'greaterThanOrEqual':
            return { part: `${col}.gte.${n}` };
        case 'lessThan':
            return { part: `${col}.lt.${n}` };
        case 'lessThanOrEqual':
            return { part: `${col}.lte.${n}` };
        case 'blank':
        case 'empty':
            return { part: `${col}.is.null` };
        case 'notBlank':
        case 'notEmpty':
            return { part: `${col}.not.is.null` };
        default:
            return { part: `${col}.eq.${n}` };
    }
}

function applySingleNumberCondition(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: any,
    col: string,
    type: string,
    filterVal: number | string | null | undefined
): { query: any; error?: string } {
    const n = parseNumber(filterVal);
    if (
        n === null &&
        type !== 'blank' &&
        type !== 'empty' &&
        type !== 'notBlank' &&
        type !== 'notEmpty'
    ) {
        return { query, error: `Filtro numérico inválido na coluna ${col}.` };
    }
    switch (type) {
        case 'equals':
            return { query: query.eq(col, n) };
        case 'notEqual':
            return { query: query.neq(col, n) };
        case 'greaterThan':
            return { query: query.gt(col, n) };
        case 'greaterThanOrEqual':
            return { query: query.gte(col, n) };
        case 'lessThan':
            return { query: query.lt(col, n) };
        case 'lessThanOrEqual':
            return { query: query.lte(col, n) };
        case 'blank':
        case 'empty':
            return { query: query.is(col, null) };
        case 'notBlank':
        case 'notEmpty':
            return { query: query.not(col, 'is', null) };
        default:
            return { query: query.eq(col, n) };
    }
}

/**
 * Encadeia filtros de coluna (modelo AG Grid) com AND sobre a query Supabase.
 */
function applyColumnFiltersToQuery(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: any,
    model: Record<string, unknown>,
    allowedColumns: Set<string>
): { query: any; error?: string } {
    let q = query;
    for (const [field, raw] of Object.entries(model)) {
        if (!allowedColumns.has(field)) {
            return { query, error: `Coluna de filtro não permitida: ${field}` };
        }
        if (raw === null || raw === undefined) continue;
        const fm = raw as Record<string, unknown>;
        const filterType = (fm.filterType as string) || 'text';

        if (filterType === 'text' || filterType === 'agTextColumnFilter') {
            const r = applyTextColumnFilter(q, field, fm as AgGridTextFilterModel);
            if (r.error) return { query, error: r.error };
            q = r.query;
            continue;
        }
        if (filterType === 'number' || filterType === 'agNumberColumnFilter') {
            const r = applyNumberColumnFilter(q, field, fm as AgGridNumberFilterModel);
            if (r.error) return { query, error: r.error };
            q = r.query;
            continue;
        }
        // set / date / multi — ignorados (não aplicados no servidor)
    }
    return { query: q };
}

function buildSearchOrClause(searchCols: string[], search: string): string {
    const trimmed = search.trim();
    const digitsOnly = /^\d+$/.test(trimmed);
    const parts: string[] = [];

    for (const c of searchCols) {
        if (TITLE_NUM_FIELDS.has(c)) {
            if (digitsOnly) {
                parts.push(`${c}.eq.${trimmed}`);
            } else {
                parts.push(`${c}.ilike.%${search}%`);
            }
        } else {
            parts.push(`${c}.ilike.%${search}%`);
        }
    }

    return parts.join(',');
}

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const table = searchParams.get('table');
        const pageRaw = parseInt(searchParams.get('page') || '1', 10);
        const limitRaw = parseInt(searchParams.get('limit') || '100', 10);
        const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
        const limit = Number.isFinite(limitRaw) ? Math.min(500, Math.max(1, limitRaw)) : 100;
        const orderBy = searchParams.get('orderBy') || 'r_e_c_n_o_';
        const search = searchParams.get('search') || '';
        const columnFiltersRaw = searchParams.get('columnFilters');
        const { model: columnFilterModel, error: columnFiltersParseErr } =
            parseColumnFiltersParam(columnFiltersRaw);
        if (columnFiltersParseErr) {
            return NextResponse.json({ success: false, message: columnFiltersParseErr }, { status: 400 });
        }
        const offset = (page - 1) * limit;

        if (!table) {
            return NextResponse.json({ success: false, message: 'Tabela não informada.' }, { status: 400 });
        }

        const config = await getConfig();
        if (!config.supabase) {
            return NextResponse.json({ success: false, message: 'Configuração inválida.' }, { status: 500 });
        }

        const supabase = createClient(config.supabase.url, config.supabase.key, {
            auth: { persistSession: false }
        });

        const tableKey = table.toLowerCase();
        
        // ── Action: columns ──────────────────────────────────────────────────
        if (searchParams.get('action') === 'columns') {
            try {
                // Fetch table schema directly via PostgREST OpenAPI definition
                const optionsRes = await fetch(`${config.supabase.url}/rest/v1/`, {
                    method: 'GET',
                    headers: {
                        'apikey': config.supabase.key,
                        'Authorization': `Bearer ${config.supabase.key}`,
                        'Accept': 'application/openapi+json'
                    }
                });

                if (optionsRes.ok) {
                    const openapi = await optionsRes.json();
                    if (openapi && openapi.definitions && openapi.definitions[tableKey]) {
                        const props = openapi.definitions[tableKey].properties || {};
                        const hiddenCols = ['id', 'd_e_l_e_t_', '__source_key', '__sap_id', '__integration_status', '__sync_message', '__last_sync', 'r_e_c_n_o_'];
                        const cols = Object.keys(props).filter(c => !hiddenCols.includes(c));
                        if (cols.length > 0) {
                            return NextResponse.json({ success: true, data: cols });
                        }
                    }
                }
            } catch (err) {
                console.warn('Fallback to select limit 1 for columns due to error:', err);
            }
            
            // Fallback: se der erro ou Swagger não retornar nada
            const fallback = await supabase.from(tableKey).select('*').limit(1);
            if (fallback.data && fallback.data.length > 0) {
                const hiddenCols = ['id', 'd_e_l_e_t_', '__source_key', '__sap_id', '__integration_status', '__sync_message', '__last_sync', 'r_e_c_n_o_'];
                const cols = Object.keys(fallback.data[0]).filter(c => !hiddenCols.includes(c));
                return NextResponse.json({ success: true, data: cols });
            }
            return NextResponse.json({ success: true, data: [] });
        }

        const isStagingTable = tableKey.startsWith('stg_');
        const primaryKey = isStagingTable ? '__source_key' : 'r_e_c_n_o_';
        const orderColumn = searchParams.get('orderBy') || primaryKey;

        // ── Monta query com filtros ANTES da paginação ─────────────────────────
        // ORDER: WHERE (search + ordem) → RANGE (página) para busca em toda a tabela
        let query = supabase
            .from(tableKey)
            .select('*', { count: 'exact' })
            .order(orderColumn, { ascending: true });

        let searchCols = SEARCH_COLUMNS[tableKey];
        if (!searchCols && isStagingTable) {
            const { data: firstRow } = await supabase.from(tableKey).select('*').limit(1);
            if (firstRow && firstRow.length > 0) {
                const excludeTypes = ['id', '__last_sync']; // id = bigint, __last_sync = timestamp (não suportam ilike diretamente)
                searchCols = Object.keys(firstRow[0]).filter(c => !excludeTypes.includes(c));
            }
        }

        // Filtro de busca textual — vai para WHERE, busca na tabela INTEIRA
        if (search && searchCols && searchCols.length > 0) {
            const orClause = buildSearchOrClause(searchCols, search);
            query = query.or(orClause);
        }

        let allowedFilterCols: Set<string> | undefined;
        if (columnFilterModel && Object.keys(columnFilterModel).length > 0) {
            allowedFilterCols = await getAllowedFilterColumns(supabase, config, tableKey);
            const applied = applyColumnFiltersToQuery(query, columnFilterModel, allowedFilterCols);
            if (applied.error) {
                return NextResponse.json({ success: false, message: applied.error }, { status: 400 });
            }
            query = applied.query;
        }

        // Paginação aplicada APÓS os filtros
        query = query.range(offset, offset + limit - 1);

        const { data, count, error } = await query;

        if (error) {
            // Fallback: tenta sem ORDER para evitar erro de coluna inexistente
            // Mantém o filtro de busca!
            let fbQuery = supabase
                .from(tableKey)
                .select('*', { count: 'exact' });

            if (search && searchCols && searchCols.length > 0) {
                const orClause = buildSearchOrClause(searchCols, search);
                fbQuery = fbQuery.or(orClause);
            }

            if (columnFilterModel && Object.keys(columnFilterModel).length > 0) {
                if (!allowedFilterCols) {
                    allowedFilterCols = await getAllowedFilterColumns(supabase, config, tableKey);
                }
                const applied = applyColumnFiltersToQuery(fbQuery, columnFilterModel, allowedFilterCols);
                if (applied.error) {
                    return NextResponse.json({ success: false, message: applied.error }, { status: 400 });
                }
                fbQuery = applied.query;
            }

            fbQuery = fbQuery.range(offset, offset + limit - 1);

            const { data: fallbackData, count: fallbackCount, error: fallbackError } = await fbQuery;

            if (fallbackError) {
                return NextResponse.json({ success: false, message: fallbackError.message }, { status: 500 });
            }

            return NextResponse.json({
                success: true,
                data: fallbackData,
                meta: {
                    page,
                    limit,
                    total: fallbackCount,
                    totalPages: fallbackCount ? Math.ceil(fallbackCount / limit) : 0,
                    searchApplied: !!search,
                    columnFiltersApplied:
                        !!(columnFilterModel && Object.keys(columnFilterModel).length > 0),
                }
            });
        }

        return NextResponse.json({
            success: true,
            data,
            meta: {
                page,
                limit,
                total: count,
                totalPages: count ? Math.ceil(count / limit) : 0,
                searchApplied: !!search,
                columnFiltersApplied:
                    !!(columnFilterModel && Object.keys(columnFilterModel).length > 0),
            }
        });

    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}

export async function PUT(request: Request) {
    try {
        const body = await request.json();
        const { table, id, data } = body;

        if (!table || !id || !data) {
            return NextResponse.json({ success: false, message: 'Dados incompletos.' }, { status: 400 });
        }

        const config = await getConfig();
        const supabase = createClient(config.supabase.url, config.supabase.key, {
            auth: { persistSession: false }
        });

        const isStagingTable = table.toLowerCase().startsWith('stg_');
        const primaryKey = isStagingTable ? '__source_key' : 'r_e_c_n_o_';

        const { error } = await supabase
            .from(table.toLowerCase())
            .update(data)
            .eq(primaryKey, id);

        if (error) {
            return NextResponse.json({ success: false, message: error.message }, { status: 500 });
        }

        return NextResponse.json({ success: true, message: 'Registro atualizado.' });

    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}
