import { NextResponse } from 'next/server';
import { sapService } from '@/services/sapService';

export async function GET() {
    try {
        const data = await sapService.getCNAEs();
        // SAP SL returns { value: [...] } wrapper usually, pass inner array
        return NextResponse.json({ success: true, data: data.value || data });
    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}
