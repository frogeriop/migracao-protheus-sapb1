import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import https from 'https';
import fs from 'fs/promises';
import path from 'path';
import { AppConfig } from '@/types/config';

const CONFIG_FILE = path.join(process.cwd(), 'config.json');

async function getConfig(): Promise<AppConfig> {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(data);
}

class SapService {
    private client: AxiosInstance | null = null;
    private cookies: string[] = [];
    private sessionTimeout: number = 0;

    private async initClient() {
        if (this.client && Date.now() < this.sessionTimeout) {
            return;
        }

        const config = await getConfig();
        if (!config.sap) throw new Error("Configuração do SAP não encontrada.");

        const { serviceLayerUrl, companyDB, userName, password, language } = config.sap;

        // Base client
        const instance = axios.create({
            baseURL: serviceLayerUrl,
            httpsAgent: new https.Agent({ rejectUnauthorized: false }), // Self-signed certs
            headers: {
                'Content-Type': 'application/json',
            }
        });

        // Login
        try {
            const loginRes = await instance.post('/Login', {
                CompanyDB: companyDB,
                UserName: userName,
                Password: password,
                Language: language || 29
            });

            // Capture cookies for SessionId and RouteId
            this.cookies = loginRes.headers['set-cookie'] || [];
            this.client = instance;

            // Set session timeout (approx 30 mins, minus buffer)
            this.sessionTimeout = Date.now() + (29 * 60 * 1000);

            console.log('SAP Login bem sucedido.');

        } catch (error: any) {
            console.error('Erro no login SAP:', error?.response?.data || error.message);
            throw new Error('Falha ao autenticar no SAP Service Layer.');
        }
    }

    private async request(method: string, url: string, data?: any, params?: any) {
        await this.initClient();

        if (!this.client) throw new Error("Cliente SAP não inicializado.");

        const config: AxiosRequestConfig = {
            method,
            url,
            data,
            params,
            headers: {
                'Cookie': this.cookies.join('; '),
                'Prefer': 'odata.maxpagesize=100' // Better pagination control
            }
        };

        try {
            const response = await this.client.request(config);
            return response.data;
        } catch (error: any) {
            // Handle specific SAP errors
            const sapError = error.response?.data?.error;
            if (sapError) {
                throw new Error(`SAP Error (${sapError.code}): ${sapError.message.value}`);
            }
            throw error;
        }
    }

    // --- Business Partners Methods ---

    /**
     * GET BusinessPartners
     * @param query OData query string (e.g. $select=CardCode,CardName&$top=10)
     */
    async getBusinessPartners(query?: string) {
        // query param handling needs to be direct or parsed
        // If passing raw query string like "$top=10"
        // axios params usually handles object. 
        // We will append query string manually if it contains $

        let url = '/BusinessPartners';
        if (query) {
            url += `?${query}`;
        }

        return this.request('GET', url);
    }

    /**
     * GET BusinessPartners(id)
     * @param cardCode The Business Partner Key
     */
    async getBusinessPartner(cardCode: string) {
        // Enforce safe string for URL
        const safeCode = encodeURIComponent(cardCode.replace(/'/g, "''"));
        return this.request('GET', `/BusinessPartners('${safeCode}')`);
    }

    /**
     * POST BusinessPartners
     * Creates a new Business Partner
     */
    async createBusinessPartner(data: any) {
        return this.request('POST', '/BusinessPartners', data);
    }

    /**
     * PATCH BusinessPartners(id)
     * Updates an existing Business Partner
     */
    async updateBusinessPartner(cardCode: string, data: any) {
        const safeCode = encodeURIComponent(cardCode.replace(/'/g, "''"));
        // SAP uses PATCH for updates usually
        return this.request('PATCH', `/BusinessPartners('${safeCode}')`, data);
    }

    /**
     * DELETE BusinessPartners(id)
     * Removes a Business Partner
     */
    async deleteBusinessPartner(cardCode: string) {
        const safeCode = encodeURIComponent(cardCode.replace(/'/g, "''"));
        return this.request('DELETE', `/BusinessPartners('${safeCode}')`);
    }

    /**
     * GET CNAEs (OCNA)
     * Retrieves the list of CNAE codes and descriptions.
     * Table: OCNA/CNAE - Note: Service Layer exposes this as 'CNAE' or 'CNAECodes' depending on version.
     * Usually 'CNAE' entity set.
     */
    async getCNAEs() {
        // Strategy: Direct SQL via ExecuteSQL
        // Since OData entities (OCNA, CNAE, CNAECodes) and CrossJoin are all failing with "Invalid entity" or similar,
        // we will try to execute a direct SQL query if the Service Layer supports it (exposed via specific endpoint or extension).
        // 
        // Note: Standard Service Layer does not universally support ad-hoc SQL for security, but some environments do or have views.
        // However, if OCNA is a valid table in the DB, it SHOULD be exposed.
        // given the consistent failures, let's try one last standard approach:
        // Querying 'CNAE' but with 'Code' property? We tried that.

        // Let's go back to the most common standard: 'CNAECodes'.
        // But the user insists on OCNA.

        // Let's try to list ALL entities again? No we did that.
        // Wait, what if we use the underlying SQL view if available?

        // Let's try the "SQLQueries" endpoint if available (for creating and running sql).
        // POST /SQLQueries
        // { "SqlCode": "GetCNAE", "SqlName": "Get CNAE List", "SqlText": "SELECT AbsId, CNAECode, Descrip FROM OCNA" }
        // Then GET /SQLQueries('GetCNAE')/List

        try {
            console.log("Tentando criar Query SQL direta para OCNA (QRY_OCNA_LIST)...");

            // 1. Check if query exists or delete it (to ensure update)
            try {
                // We attempt to get it first, if it exists we delete it to recreate with potentially new SQL
                // Or just try DELETE directly, ignoring 404
                await this.request('DELETE', "/SQLQueries('QRY_OCNA_LIST')");
            } catch (e) { /* ignore if not exists */ }

            // 2. Create Query
            await this.request('POST', '/SQLQueries', {
                "SqlCode": "QRY_OCNA_LIST",
                "SqlName": "OCNA - Lista CNAE",
                "SqlText": "SELECT \"AbsId\", \"CNAECode\", \"Descrip\" FROM \"OCNA\" ORDER BY \"CNAECode\""
            });

            // 3. Execute Query
            console.log("Executando Query SQL...");
            const response = await this.request('GET', "/SQLQueries('QRY_OCNA_LIST')/List");

            if (response && response.value) {
                return response.value.map((row: any) => ({
                    AbsId: row.AbsId,
                    CNAECode: row.CNAECode,
                    Description: row.Descrip
                }));
            }
        } catch (error: any) {
            console.warn("Falha ao usar SQLQueries:", error.message);
            // If creation failed because it already exists (and delete failed?), try executing anyway?
            try {
                const response = await this.request('GET', "/SQLQueries('QRY_OCNA_LIST')/List");
                if (response && response.value) {
                    return response.value.map((row: any) => ({
                        AbsId: row.AbsId,
                        CNAECode: row.CNAECode,
                        Description: row.Descrip
                    }));
                }
            } catch (e) { /* ignore */ }
        }

        throw new Error("Não foi possível acessar a tabela OCNA via SQLQueries (QRY_OCNA_LIST). Verifique permissões para criar/executar queries.");
    }
}

export const sapService = new SapService();
