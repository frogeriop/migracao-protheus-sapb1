import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function GET() {
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    const q1 = await supabase.from('ibge_municipios').select('*').eq('municipio', '11300');
    return NextResponse.json({ result: q1.data, error: q1.error });
}
