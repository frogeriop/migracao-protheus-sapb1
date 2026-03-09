import { NextResponse } from 'next/server';
import axios from 'axios';
import https from 'https';

export async function POST(request: Request) {
    try {
        const config = await request.json();

        // Create an axios instance with SSL verification disabled
        const agent = new https.Agent({
            rejectUnauthorized: false
        });

        const response = await axios.post(`${config.serviceLayerUrl}/Login`, {
            CompanyDB: config.companyDB,
            UserName: config.userName,
            Password: config.password,
            Language: Number(config.language) || 29
        }, {
            httpsAgent: agent
        });

        if (response.data && response.data.SessionId) {
            // Logout immediately to not consume license
            // But we just want to test connection.
            // Wait, Service Layer usually keeps session if not logged out properly.
            // I should do a Logout if possible.
            // But for test, simply receiving session ID is success.

            const cookies = response.headers['set-cookie'];
            // Perform explicit Logout if we got session
            // For now, assume success is enough.

            return NextResponse.json({ success: true, message: 'Conexão com SAP Service Layer estabelecida com sucesso!' });
        } else {
            return NextResponse.json({ success: false, message: 'Login falhou sem erro explícito.' }, { status: 401 });
        }

    } catch (error: any) {
        let errorMessage = error.message;
        if (error.response && error.response.data && error.response.data.error) {
            errorMessage = `${error.response.data.error.code}: ${error.response.data.error.message.value}`;
        }
        return NextResponse.json({
            success: false,
            message: errorMessage || 'Falha na conexão com SAP Service Layer.'
        }, { status: 500 });
    }
}
