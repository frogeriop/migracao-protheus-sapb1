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

/**
 * GET /api/sap/chart-of-accounts/search?q=...&limit=15
 * Busca contas contábeis na tabela local sap_chart_of_accounts por código ou nome.
 * Retorna até `limit` resultados (default 15).
 */
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const q = (searchParams.get('q') || '').trim();
        const limit = Math.min(parseInt(searchParams.get('limit') || '15', 10), 50);

        if (!q || q.length < 1) {
            return NextResponse.json({ success: true, data: [] });
        }

        const config = await getConfig();
        const supabase = createClient(config.supabase.url, config.supabase.key, {
            auth: { persistSession: false },
        });

        // Busca por código (starts-with) OU nome (contains) — case-insensitive
        const { data, error } = await supabase
            .from('sap_chart_of_accounts')
            .select('code, name, account_type')
            .or(`code.ilike.${q}%,name.ilike.%${q}%`)
            .order('code', { ascending: true })
            .limit(limit);

        if (error) throw new Error(error.message);

        return NextResponse.json({ success: true, data: data || [] });
    } catch (error: any) {
        console.error('[sap/chart-of-accounts/search]', error.message);
        return NextResponse.json(
            { success: false, message: error.message },
            { status: 500 }
        );
    }
}
