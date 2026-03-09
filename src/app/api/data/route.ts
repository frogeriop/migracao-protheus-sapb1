import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
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
    sb1010: ['b1_cod', 'b1_desc'],
    se1010: ['e1_num', 'e1_cliente', 'e1_nomcli', 'e1_prefixo', 'e1_tipo'],
    se2010: ['e2_num', 'e2_fornece', 'e2_nomfor', 'e2_prefixo', 'e2_tipo'],
    sed010: ['ed_codigo', 'ed_descric', 'ed_conta', 'sap_account_code', 'sap_account_name'],
    sap_chart_of_accounts: ['code', 'name', 'account_type', 'father_account'],
    sap_cost_centers: ['code', 'name'],
};

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const table = searchParams.get('table');
        const page = parseInt(searchParams.get('page') || '1');
        const limit = parseInt(searchParams.get('limit') || '100');
        const orderBy = searchParams.get('orderBy') || 'r_e_c_n_o_';
        const search = searchParams.get('search') || '';
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

        // ── Monta query com filtros ANTES da paginação ─────────────────────────
        // ORDER: WHERE (search + ordem) → RANGE (página) para busca em toda a tabela
        let query = supabase
            .from(tableKey)
            .select('*', { count: 'exact' })
            .order(orderBy, { ascending: true });

        // Filtro de busca textual — vai para WHERE, busca na tabela INTEIRA
        if (search) {
            const cols = SEARCH_COLUMNS[tableKey];
            if (cols && cols.length > 0) {
                const orClause = cols.map(c => `${c}.ilike.%${search}%`).join(',');
                query = query.or(orClause);
            }
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

            if (search) {
                const cols = SEARCH_COLUMNS[tableKey];
                if (cols && cols.length > 0) {
                    const orClause = cols.map(c => `${c}.ilike.%${search}%`).join(',');
                    fbQuery = fbQuery.or(orClause);
                }
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

        const { error } = await supabase
            .from(table.toLowerCase())
            .update(data)
            .eq('r_e_c_n_o_', id);

        if (error) {
            return NextResponse.json({ success: false, message: error.message }, { status: 500 });
        }

        return NextResponse.json({ success: true, message: 'Registro atualizado.' });

    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}
