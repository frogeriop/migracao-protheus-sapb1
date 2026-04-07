import fs from 'fs/promises';
import path from 'path';
import type { AppConfig } from '@/types/config';

export const CONFIG_FILE = path.join(process.cwd(), 'config.json');

const defaultConfig: AppConfig = {
    protheus: {
        server: 'localhost',
        database: '',
        user: '',
        password: '',
        port: 1433,
        driver: 'msnodesqlv8',
    },
    sap: {
        serviceLayerUrl: 'https://myserver:50000/b1s/v1',
        companyDB: '',
        userName: '',
        password: '',
        language: '29',
    },
    supabase: {
        url: 'https://tdieqskomdgjjohywgzo.supabase.co',
        key: '',
    },
};

export async function getConfig(): Promise<AppConfig> {
    try {
        const data = await fs.readFile(CONFIG_FILE, 'utf-8');
        return { ...defaultConfig, ...JSON.parse(data) };
    } catch {
        return defaultConfig;
    }
}
