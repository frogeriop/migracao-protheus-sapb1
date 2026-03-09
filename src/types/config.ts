export interface ProtheusConfig {
    server: string;
    database: string;
    user: string;
    password?: string;
    port: number;
    driver?: string;
}

export interface SapConfig {
    serviceLayerUrl: string;
    companyDB: string;
    userName: string;
    password?: string;
    language?: string;
}

export interface SupabaseConfig {
    url: string;
    key: string;
}

export interface AppConfig {
    protheus: ProtheusConfig;
    sap: SapConfig;
    supabase: SupabaseConfig;
}
