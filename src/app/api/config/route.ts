import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { AppConfig } from '@/types/config';

const CONFIG_FILE = path.join(process.cwd(), 'config.json');

const defaultConfig: AppConfig = {
    protheus: {
        server: 'localhost',
        database: '',
        user: '',
        password: '',
        port: 1433,
        driver: 'msnodesqlv8'
    },
    sap: {
        serviceLayerUrl: 'https://myserver:50000/b1s/v1',
        companyDB: '',
        userName: '',
        password: '',
        language: '29' // Portuguese - Brazil
    },
    supabase: {
        url: 'https://tdieqskomdgjjohywgzo.supabase.co',
        key: ''
    }
};

async function getConfig(): Promise<AppConfig> {
    try {
        const data = await fs.readFile(CONFIG_FILE, 'utf-8');
        return { ...defaultConfig, ...JSON.parse(data) };
    } catch (error) {
        return defaultConfig;
    }
}

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
