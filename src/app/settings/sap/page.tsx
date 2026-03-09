'use client';

import { useEffect, useState } from 'react';
import { FolderOutput } from 'lucide-react';
import { ConnectionCard } from '@/components/ui/ConnectionCard';
import { useConfig } from '@/hooks/useConfig';
import { SapConfig } from '@/types/config';

export default function SapSettingsPage() {
    const { config, loading, updateSapConfig, saveConfig } = useConfig();
    const [localConfig, setLocalConfig] = useState<SapConfig | null>(null);

    useEffect(() => {
        if (config?.sap) {
            setLocalConfig(config.sap);
        }
    }, [config]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!localConfig) return;
        const { name, value } = e.target;
        // Handle number inputs if needed, though input type="text" works for most unless explicit number required
        const updated = { ...localConfig, [name]: value };
        setLocalConfig(updated);
        updateSapConfig(updated);
    };

    const handleTest = async () => {
        if (!localConfig) return { success: false, message: 'Configuração inválida' };

        const res = await fetch('/api/connections/sap', {
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
            <h1 className="page-title">Configuração SAP Business One</h1>

            <ConnectionCard
                title="SAP Service Layer"
                description="Configure o acesso à Service Layer do SAP Business One."
                icon={<FolderOutput size={24} />}
                onTest={handleTest}
                onSave={handleSave}
            >
                <div className="input-group">
                    <label className="label">Service Layer URL</label>
                    <input
                        className="input"
                        name="serviceLayerUrl"
                        value={localConfig.serviceLayerUrl}
                        onChange={handleChange}
                        placeholder="https://myserver:50000/b1s/v1"
                    />
                </div>

                <div className="input-group">
                    <label className="label">Banco de Dados (Company DB)</label>
                    <input
                        className="input"
                        name="companyDB"
                        value={localConfig.companyDB}
                        onChange={handleChange}
                        placeholder="SBO_COMMON"
                    />
                </div>

                <div className="input-group">
                    <label className="label">Usuário</label>
                    <input
                        className="input"
                        name="userName"
                        value={localConfig.userName}
                        onChange={handleChange}
                        placeholder="manager"
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
                    <label className="label">Language Code</label>
                    <input
                        className="input"
                        name="language"
                        value={localConfig.language}
                        onChange={handleChange}
                        placeholder="29 (Portuguese - Brazil)"
                    />
                </div>
            </ConnectionCard>
        </div>
    );
}
