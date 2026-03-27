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

export async function GET() {
    try {
        const config = await getConfig();
        const supabase = createClient(config.supabase.url, config.supabase.key, { auth: { persistSession: false } });

        const { data, error } = await supabase
            .from('migration_entities')
            .select('*')
            .order('group_name', { ascending: true })
            .order('name', { ascending: true });

        if (error) {
            return NextResponse.json({ success: false, message: error.message }, { status: 500 });
        }

        return NextResponse.json({ success: true, data });
    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const config = await getConfig();
        const supabase = createClient(config.supabase.url, config.supabase.key, { auth: { persistSession: false } });

        const { data, error } = await supabase
            .from('migration_entities')
            .insert([body])
            .select()
            .single();

        if (error) {
            return NextResponse.json({ success: false, message: error.message }, { status: 500 });
        }

        return NextResponse.json({ success: true, data });
    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}

export async function PATCH(request: Request) {
    try {
        const body = await request.json();
        const { id, ...updates } = body;

        if (!id) {
            return NextResponse.json({ success: false, message: 'ID is required' }, { status: 400 });
        }

        const config = await getConfig();
        const supabase = createClient(config.supabase.url, config.supabase.key, { auth: { persistSession: false } });

        if (updates.source_file_path === null) {
            // Unlinking: drop the staging table to clear data and schema
            const { data: entity } = await supabase.from('migration_entities').select('staging_table').eq('id', id).single();
            if (entity && entity.staging_table) {
                await supabase.rpc('exec_sql', { query: `DROP TABLE IF EXISTS "${entity.staging_table}" CASCADE;` });
                await supabase.rpc('exec_sql', { query: "NOTIFY pgrst, 'reload schema';" });
            }
        }

        const { data, error } = await supabase
            .from('migration_entities')
            .update(updates)
            .eq('id', id)
            .select()
            .single();

        if (error) {
            return NextResponse.json({ success: false, message: error.message }, { status: 500 });
        }

        return NextResponse.json({ success: true, data });
    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}
