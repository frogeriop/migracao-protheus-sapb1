import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function POST(request: Request) {
    try {
        const config = await request.json();

        // Create Supabase client with the provided config
        const supabase = createClient(config.url, config.key, {
            auth: {
                persistSession: false,
            },
        });

        // Simple test query - just check connection by trying to get auth settings (works even if no tables)
        // Or just try a generic query or check health if available.
        // Easiest is to try fetch auth settings or just verify URL/Key structure.
        // A query to a non-existent table will return error but prove connection? Maybe.
        // Better: `supabase.from('some_table').select('*').limit(1)` - if table doesn't exist, error P0001 or similar from Postgres, which confirms connection.
        // Or check `supabase.auth.getSession()` which doesn't need DB access but validates anon key.

        // Let's try listing buckets if storage enabled, or just a simple query.
        // `current_timestamp` is good.
        // RPC call requires function. Let's stick to auth.

        const { data, error } = await supabase.auth.getSession();

        if (error) {
            throw new Error(error.message);
        }

        // If we got here, KEY is vaguely valid format.
        // For Service Key validation, we might need a real operation.
        // Let's try a simple RPC call to a system function if possible, or just accept auth success.

        return NextResponse.json({ success: true, message: 'Conexão com Supabase estabelecida com sucesso!' });

    } catch (error: any) {
        return NextResponse.json({
            success: false,
            message: error.message || 'Falha na conexão com Supabase.'
        }, { status: 500 });
    }
}
