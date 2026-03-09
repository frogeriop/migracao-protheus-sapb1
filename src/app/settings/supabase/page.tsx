'use client';

import { useEffect, useState } from 'react';
import { HardDrive } from 'lucide-react';
import { ConnectionCard } from '@/components/ui/ConnectionCard';
import { useConfig } from '@/hooks/useConfig';
import { SupabaseConfig } from '@/types/config';

export default function SupabaseSettingsPage() {
    const { config, loading, updateSupabaseConfig, saveConfig } = useConfig();
    const [localConfig, setLocalConfig] = useState<SupabaseConfig | null>(null);

    useEffect(() => {
        if (config?.supabase) {
            setLocalConfig(config.supabase);
        }
    }, [config]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!localConfig) return;
        const { name, value } = e.target;
        // Handle number inputs if needed, though input type="text" works for most unless explicit number required
        const updated = { ...localConfig, [name]: value };
        setLocalConfig(updated);
        updateSupabaseConfig(updated);
    };

    const handleTest = async () => {
        if (!localConfig) return { success: false, message: 'Configuração inválida' };

        // Test with current local config
        const res = await fetch('/api/connections/supabase', {
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
            <h1 className="page-title">Configuração Supabase (Intermediário)</h1>

            <ConnectionCard
                title="Supabase Database"
                description="Configure a conexão com o banco de dados intermediário Supabase."
                icon={<HardDrive size={24} />}
                onTest={handleTest}
                onSave={handleSave}
            >
                <div className="input-group">
                    <label className="label">Project URL</label>
                    <input
                        className="input"
                        name="url"
                        value={localConfig.url}
                        onChange={handleChange}
                        placeholder="https://xyz.supabase.co"
                    />
                </div>

                <div className="input-group">
                    <label className="label">Anon Key / Service Role Key</label>
                    <input
                        className="input"
                        name="key"
                        type="password"
                        value={localConfig.key}
                        onChange={handleChange}
                        placeholder="eyJbh..."
                    />
                </div>
            </ConnectionCard>
        </div>
    );
}
