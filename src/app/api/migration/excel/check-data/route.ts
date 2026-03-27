import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getConfig } from '@/lib/config-helper';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const tableName = searchParams.get('table');

        if (!tableName) {
            return NextResponse.json({ error: 'Parâmetro `table` é obrigatório.' }, { status: 400 });
        }

        const config = await getConfig();
        const supabase = createClient(config.supabase.url, config.supabase.key, { auth: { persistSession: false } });

        // Tentar ler a tabela e contar as linhas
        const { data, error, count } = await supabase
            .from(tableName)
            .select('*', { count: 'exact', head: false })
            .limit(5);

        if (error) {
            return NextResponse.json({ 
                success: false, 
                message: `Tabela '${tableName}' com erro ou não encontrada: ${error.message}`
            }, { status: 500 });
        }

        return NextResponse.json({ 
            success: true, 
            message: `Verificação concluída: A tabela '${tableName}' existe e possui ${count} registro(s) no total.`,
            count,
            sampleData: data
        });

    } catch (e: any) {
        return NextResponse.json({ success: false, message: e.message }, { status: 500 });
    }
}
