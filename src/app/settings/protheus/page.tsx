'use client';

import { useEffect, useState } from 'react';
import { Database } from 'lucide-react';
import { ConnectionCard } from '@/components/ui/ConnectionCard';
import { useConfig } from '@/hooks/useConfig';
import { ProtheusConfig } from '@/types/config';

export default function ProtheusSettingsPage() {
    const { config, loading, updateProtheusConfig, saveConfig } = useConfig();
    const [localConfig, setLocalConfig] = useState<ProtheusConfig | null>(null);

    useEffect(() => {
        if (config?.protheus) {
            setLocalConfig(config.protheus);
        }
    }, [config]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!localConfig) return;
        const { name, value } = e.target;
        const updated = { ...localConfig, [name]: value };
        setLocalConfig(updated);
        updateProtheusConfig(updated);
    };

    const handleTest = async () => {
        if (!localConfig) return { success: false, message: 'Configuração inválida' };

        // Test with current local config
        const res = await fetch('/api/connections/protheus', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(localConfig),
        });

        const data = await res.json();
        return { success: data.success, message: data.message };
    };

    const handleSave = async () => {
        await saveConfig();
    };

    if (loading) return <div>Carregando...</div>;
    if (!localConfig) return <div>Erro ao carregar configurações.</div>;

    return (
        <div className="container">
            <h1 className="page-title">Configuração Protheus (Origem)</h1>

            <ConnectionCard
                title="Banco de Dados SQL Server"
                description="Configure a conexão com o banco de dados do TOTVS Protheus."
                icon={<Database size={24} />}
                onTest={handleTest}
                onSave={handleSave}
            >
                <div className="input-group">
                    <label className="label">Servidor</label>
                    <input
                        className="input"
                        name="server"
                        value={localConfig.server}
                        onChange={handleChange}
                        placeholder="Ex: localhost ou 192.168.1.10"
                    />
                </div>

                <div className="input-group">
                    <label className="label">Banco de Dados</label>
                    <input
                        className="input"
                        name="database"
                        value={localConfig.database}
                        onChange={handleChange}
                        placeholder="Ex: PROTHEUS_DATA"
                    />
                </div>

                <div className="input-group">
                    <label className="label">Usuário</label>
                    <input
                        className="input"
                        name="user"
                        value={localConfig.user}
                        onChange={handleChange}
                        placeholder="sa"
                    />
                </div>

                <div className="input-group">
                    <label className="label">Senha</label>
                    <input
                        className="input"
                        name="password"
                        type="password"
                        value={localConfig.password}
                        onChange={handleChange}
                    />
                </div>

                <div className="input-group">
                    <label className="label">Porta</label>
                    <input
                        className="input"
                        name="port"
                        type="number"
                        value={localConfig.port}
                        onChange={handleChange}
                        placeholder="1433"
                    />
                </div>
            </ConnectionCard>
        </div>
    );
}
