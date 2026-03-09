import { NextResponse } from 'next/server';
import { sapService } from '@/services/sapService';

// GET: Single Business Partner
export async function GET(request: Request, { params }: { params: { id: string } }) {
    try {
        const data = await sapService.getBusinessPartner(params.id);
        return NextResponse.json({ success: true, data });
    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 404 });
    }
}

// PATCH: Update Business Partner
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
    try {
        const body = await request.json();
        const data = await sapService.updateBusinessPartner(params.id, body);
        return NextResponse.json({ success: true, data });
    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}

// DELETE: Remove Business Partner
export async function DELETE(request: Request, { params }: { params: { id: string } }) {
    try {
        await sapService.deleteBusinessPartner(params.id);
        return NextResponse.json({ success: true, message: 'Parceiro de Negócios removido.' });
    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}
