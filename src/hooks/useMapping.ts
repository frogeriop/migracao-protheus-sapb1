'use client';

import { useState, useEffect } from 'react';
import { MappingConfig, TableMapping, FieldMapping } from '@/types/mapping';

export function useMapping() {
    const [config, setConfig] = useState<MappingConfig>({});
    const [loading, setLoading] = useState(true);

    const fetchMappings = async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/mapping');
            const json = await res.json();
            if (json.success) {
                setConfig(json.data);
            }
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchMappings();
    }, []);

    const updateTableMapping = async (tableName: string, mapping: TableMapping) => {
        const newConfig = { ...config, [tableName]: mapping };

        try {
            // Optimistic Update
            setConfig(newConfig);

            const res = await fetch('/api/mapping', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [tableName]: mapping })
            });
            const json = await res.json();
            if (!json.success) throw new Error(json.message);

        } catch (error) {
            alert('Erro ao salvar mapeamento.');
            fetchMappings(); // Revert
        }
    };

    return { config, loading, updateTableMapping, fetchMappings };
}
