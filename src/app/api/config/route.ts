import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import { CONFIG_FILE, getConfig } from '@/lib/config-helper';

export async function GET() {
    const config = await getConfig();
    // Don't modify response security yet, just return JSON
    return NextResponse.json(config);
}

export async function POST(request: Request) {
    try {
        const newConfig = await request.json();
        const currentConfig = await getConfig();
        const configToSave = { ...currentConfig, ...newConfig };

        await fs.writeFile(CONFIG_FILE, JSON.stringify(configToSave, null, 2));

        return NextResponse.json({ success: true });
    } catch (error) {
        return NextResponse.json({ success: false, error: 'Failed to save config' }, { status: 500 });
    }
}
