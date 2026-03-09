import { NextResponse } from 'next/server';
import { sapService } from '@/services/sapService';

// GET: Query Business Partners
export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const limit = searchParams.get('$top') || '20';
        const skip = searchParams.get('$skip') || '0';

        // Expanded selection to include OCRD, CRD1 (BPAddresses) and CRD7 (BPFiscalTaxIDCollection) fields
        // BPAddresses and BPFiscalTaxIDCollection are complex types, so they belong in $select, not $expand
        const query = `$select=CardCode,CardName,CardType,GroupCode,FederalTaxID,EmailAddress,Phone1,BPAddresses,BPFiscalTaxIDCollection&$top=${limit}&$skip=${skip}`;

        const data = await sapService.getBusinessPartners(query);
        return NextResponse.json({ success: true, data });
    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}

// POST: Create Business Partner
export async function POST(request: Request) {
    try {
        const body = await request.json();
        const data = await sapService.createBusinessPartner(body);
        return NextResponse.json({ success: true, data });
    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}
