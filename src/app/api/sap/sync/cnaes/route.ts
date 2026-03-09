import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sapService } from '@/services/sapService';
import fs from 'fs/promises';
import path from 'path';
import { AppConfig } from '@/types/config';

const CONFIG_FILE = path.join(process.cwd(), 'config.json');

async function getConfig(): Promise<AppConfig> {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(data);
}

export async function POST() {
    try {
        const config = await getConfig();
        if (!config.supabase) return NextResponse.json({ success: false, message: 'Configuração inválida.' }, { status: 500 });

        const supabase = createClient(config.supabase.url, config.supabase.key, { auth: { persistSession: false } });

        // 1. Fetch from SAP
        const sapRes = await sapService.getCNAEs();
        const cnaes = sapRes.value || sapRes; // Handle OData wrapper

        if (!Array.isArray(cnaes)) {
            return NextResponse.json({ success: false, message: 'Formato de resposta SAP inválido.' }, { status: 500 });
        }

        // 2. Transform: Handle variations in field names
        const rows = cnaes.map((c: any) => ({
            id: c.AbsId || c.ID || c.Code, // Fallback for ID if AbsId/ID missing
            code: c.CNAECode || c.Code || c.Id, // Fallback for Code
            description: c.Description || c.Descrip || c.Name || '', // Fallback for Description
            // updated_at could be now()
        })).filter(r => r.code); // Ensure at least code exists

        if (rows.length === 0) {
            return NextResponse.json({ success: true, message: 'Nenhum CNAE encontrado no SAP.' });
        }

        // 3. Upsert to Supabase
        // Split into batches of 1000 to be safe
        const batchSize = 1000;
        let insertedCount = 0;

        for (let i = 0; i < rows.length; i += batchSize) {
            const batch = rows.slice(i, i + batchSize);
            const { error } = await supabase.from('sap_cnaes').upsert(batch);

            if (error) {
                console.error('Erro ao inserir batch:', error);
                throw new Error(`Falha ao inserir na tabela sap_cnaes: ${error.message}`);
            }
            insertedCount += batch.length;
        }

        return NextResponse.json({ success: true, count: insertedCount, message: 'CNAEs sincronizados com sucesso.' });

    } catch (error: any) {
        console.error(error);
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}
