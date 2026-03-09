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

// GET /api/naturezas/mapping?search=xxx  — busca contas SAP B1
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const search = searchParams.get('search') || '';

        const config = await getConfig();
        const supabase = createClient(config.supabase.url, config.supabase.key, {
            auth: { persistSession: false }
        });

        let query = supabase
            .from('sap_chart_of_accounts')
            .select('code, name, account_type, father_account')
            .order('code', { ascending: true })
            .limit(50);

        if (search) {
            query = query.or(`code.ilike.%${search}%,name.ilike.%${search}%`);
        }

        const { data, error } = await query;
        if (error) throw new Error(error.message);

        return NextResponse.json({ success: true, data: data || [] });
    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}

// PATCH /api/naturezas/mapping  — salva vínculo
// body: { ed_codigo, ed_filial, sap_account_code, sap_account_name }
export async function PATCH(request: Request) {
    try {
        const body = await request.json();
        const { ed_codigo, ed_filial, sap_account_code, sap_account_name } = body;

        if (!ed_codigo) {
            return NextResponse.json({ success: false, message: 'ed_codigo é obrigatório.' }, { status: 400 });
        }

        const config = await getConfig();
        const supabase = createClient(config.supabase.url, config.supabase.key, {
            auth: { persistSession: false }
        });

        const { error } = await supabase
            .from('sed010')
            .update({
                sap_account_code: sap_account_code || null,
                sap_account_name: sap_account_name || null,
                updated_at: new Date().toISOString(),
            })
            .eq('ed_codigo', ed_codigo)
            .eq('ed_filial', ed_filial || '01');

        if (error) throw new Error(error.message);

        return NextResponse.json({ success: true });
    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}
