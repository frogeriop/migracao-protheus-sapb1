import { NextResponse } from 'next/server';
import sql from 'mssql';

export async function POST(request: Request) {
    try {
        const config = await request.json();

        const dbConfig = {
            server: config.server,
            database: config.database,
            user: config.user,
            password: config.password,
            port: Number(config.port) || 1433,
            options: {
                encrypt: false, // For local dev usually false, but for production true.
                trustServerCertificate: true // Self-signed certs common in dev
            }
        };

        const pool = await sql.connect(dbConfig);
        await pool.close();

        return NextResponse.json({ success: true, message: 'Conexão com TOTVS Protheus (SQL Server) estabelecida com sucesso!' });
    } catch (error: any) {
        return NextResponse.json({
            success: false,
            message: error.message || 'Falha na conexão com o banco de dados.'
        }, { status: 500 });
    }
}
