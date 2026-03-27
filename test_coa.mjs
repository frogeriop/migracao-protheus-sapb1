import fs from 'fs';

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

async function testCOA() {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    console.log("Logging into SAP...");
    const loginRes = await fetch(`${config.sap.serviceLayerUrl}/Login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            CompanyDB: config.sap.companyDB,
            UserName: config.sap.userName,
            Password: config.sap.password
        })
    });

    if (!loginRes.ok) {
        console.error("Login failed:", await loginRes.text());
        return;
    }
    const cookies = loginRes.headers.get('set-cookie');
    console.log("Login successful.");

    const payload = {
        ActiveAccount: "tNO",
        Code: "102_TEST",
        Name: "Ativo Não Circulante Teste API",
        FatherAccountKey: "1"
    };

    console.log("Posting to ChartOfAccounts:", payload);
    const postRes = await fetch(`${config.sap.serviceLayerUrl}/ChartOfAccounts`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Cookie': cookies
        },
        body: JSON.stringify(payload)
    });

    if (postRes.ok) {
        console.log("Success! Data:", await postRes.text());
        
        // Cleanup: Let's delete it so we don't pollute the SAP database
        console.log("Deleting test account...");
        const delRes = await fetch(`${config.sap.serviceLayerUrl}/ChartOfAccounts('102_TEST')`, {
            method: 'DELETE',
            headers: { 'Cookie': cookies }
        });
        if (delRes.ok) console.log("Test account deleted successfully.");
        else console.log("Failed to delete test account:", await delRes.text());
    } else {
        console.error(`Failed! Status: ${postRes.status}, Error:`, await postRes.text());
    }
}

testCOA();
