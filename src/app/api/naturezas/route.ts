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

// GET: Listar naturezas com paginação e busca
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const page = parseInt(searchParams.get('page') || '1');
        const limit = parseInt(searchParams.get('limit') || '50');
        const search = searchParams.get('search') || '';
        const offset = (page - 1) * limit;

        const config = await getConfig();
        const supabase = createClient(config.supabase.url, config.supabase.key, {
            auth: { persistSession: false }
        });

        let query = supabase
            .from('sed010')
            .select('*', { count: 'exact' })
            .range(offset, offset + limit - 1)
            .order('ed_codigo', { ascending: true });

        if (search) {
            query = query.or(`ed_codigo.ilike.%${search}%,ed_descric.ilike.%${search}%,sap_account_code.ilike.%${search}%`);
        }

        const { data, count, error } = await query;

        if (error) throw error;

        return NextResponse.json({
            success: true,
            data,
            meta: {
                page,
                limit,
                total: count,
                totalPages: count ? Math.ceil(count / limit) : 0
            }
        });
    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}

// PATCH: Atualizar conta SAP de uma natureza
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

        const updateData: any = {};
        if (sap_account_code !== undefined) updateData.sap_account_code = sap_account_code;
        if (sap_account_name !== undefined) updateData.sap_account_name = sap_account_name;

        const { error } = await supabase
            .from('sed010')
            .update(updateData)
            .eq('ed_codigo', ed_codigo)
            .eq('ed_filial', ed_filial || '');

        if (error) throw error;

        return NextResponse.json({ success: true, message: 'Natureza atualizada com sucesso.' });
    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}

// DELETE: Limpar tabela
export async function DELETE(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const confirm = searchParams.get('confirm');

        if (confirm !== 'true') {
            return NextResponse.json({ success: false, message: 'Confirmação necessária.' }, { status: 400 });
        }

        const config = await getConfig();
        const supabase = createClient(config.supabase.url, config.supabase.key, {
            auth: { persistSession: false }
        });

        const { error } = await supabase.from('sed010').delete().neq('ed_codigo', '');

        if (error) throw error;

        return NextResponse.json({ success: true, message: 'Tabela SED010 limpa com sucesso.' });
    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}
