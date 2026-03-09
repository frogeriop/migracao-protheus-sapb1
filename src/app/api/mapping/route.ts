import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { MappingConfig } from '@/types/mapping';

const MAPPING_FILE = path.join(process.cwd(), 'mapping.json');

async function getMappings(): Promise<MappingConfig> {
    try {
        const data = await fs.readFile(MAPPING_FILE, 'utf-8');
        return JSON.parse(data);
    } catch {
        // If file doesn't exist, return empty object
        return {};
    }
}

export async function GET() {
    try {
        const mappings = await getMappings();
        return NextResponse.json({ success: true, data: mappings });
    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        // Overwrite or Merge? Let's assume full save for a specific table or full config.
        // Let's implement full save for simplicity for now, or per-key update.
        // The body should probably be the whole config or a specific table mapping.
        // Let's expect the full updated MappingConfig or a partial update. 
        // For safety, let's read existing and merge.

        const existing = await getMappings();
        const updates = body as MappingConfig;

        const newConfig = { ...existing, ...updates };

        await fs.writeFile(MAPPING_FILE, JSON.stringify(newConfig, null, 2), 'utf-8');

        return NextResponse.json({ success: true, message: 'Mapeamento salvo com sucesso.' });
    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}
