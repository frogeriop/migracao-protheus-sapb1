import { createClient } from '@supabase/supabase-js';
import fs from 'fs/promises';
import path from 'path';

const CONFIG_FILE = path.join(process.cwd(), 'config.json');
async function getConfig() {
    try { return JSON.parse(await fs.readFile(CONFIG_FILE, 'utf-8')); } catch { return null; }
}

/**
 * GET /api/control-tower/db-inspector?table=sa2010&limit=50&offset=0
 * Read-only table inspection. Returns columns + rows.
 */
export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const table = searchParams.get('table') || '';
    const limit = Math.min(Number(searchParams.get('limit') || 50), 200);
    const offset = Number(searchParams.get('offset') || 0);
    const filter = searchParams.get('filter') || '';

    const config = await getConfig();
    if (!config?.supabase) {
        return Response.json({ error: 'Supabase não configurado.' }, { status: 400 });
    }

    const sb = createClient(config.supabase.url, config.supabase.key, { auth: { persistSession: false } });

    // List available tables
    if (!table) {
        const { data } = await sb.rpc('exec_sql', {
            query: `SELECT table_name, 
                           (SELECT COUNT(*) FROM information_schema.columns c WHERE c.table_name = t.table_name AND c.table_schema='public') as col_count
                    FROM information_schema.tables t
                    WHERE table_schema='public' AND table_type='BASE TABLE'
                    ORDER BY table_name`,
        });
        return Response.json({ tables: data });
    }

    // Get columns
    const { data: cols } = await sb.rpc('exec_sql', {
        query: `SELECT column_name, data_type, is_nullable
                FROM information_schema.columns
                WHERE table_name = '${table.replace(/'/g, '')}' AND table_schema = 'public'
                ORDER BY ordinal_position`,
    });

    // Get rows - read-only SELECT with optional text filter
    let q = sb.from(table).select('*').range(offset, offset + limit - 1);
    // Count
    const { count } = await sb.from(table).select('*', { count: 'exact', head: true });

    const { data: rows, error } = await q;

    if (error) return Response.json({ error: error.message }, { status: 500 });

    return Response.json({ table, columns: cols, rows, total: count, offset, limit });
}
