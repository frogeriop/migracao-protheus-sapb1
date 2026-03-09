import { useState, useEffect } from 'react';
import { AppConfig, ProtheusConfig, SapConfig, SupabaseConfig } from '@/types/config';

export function useConfig() {
    const [config, setConfig] = useState<AppConfig | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fetch('/api/config')
            .then((res) => res.json())
            .then((data) => {
                setConfig(data);
                setLoading(false);
            })
            .catch((err) => {
                setError('Failed to load configuration');
                setLoading(false);
            });
    }, []);

    const updateProtheusConfig = (newConfig: ProtheusConfig) => {
        if (!config) return;
        setConfig({ ...config, protheus: newConfig });
    };

    const updateSapConfig = (newConfig: SapConfig) => {
        if (!config) return;
        setConfig({ ...config, sap: newConfig });
    };

    const updateSupabaseConfig = (newConfig: SupabaseConfig) => {
        if (!config) return;
        setConfig({ ...config, supabase: newConfig });
    };

    const saveConfig = async () => {
        if (!config) return;
        try {
            await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config),
            });
        } catch (err) {
            setError('Failed to save configuration');
        }
    };

    return { config, loading, error, updateProtheusConfig, updateSapConfig, updateSupabaseConfig, saveConfig };
}
