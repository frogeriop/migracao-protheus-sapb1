import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getConfig } from '@/lib/config-helper';

export async function GET() {
    try {
        const config = await getConfig();
        const supabase = createClient(config.supabase.url, config.supabase.key, { auth: { persistSession: false } });

        const { data, error } = await supabase
            .from('migration_entities')
            .select('*');

        if (error) throw error;

        return NextResponse.json({ success: true, data });
    } catch (e: any) {
        return NextResponse.json({ success: false, message: e.message }, { status: 500 });
    }
}
