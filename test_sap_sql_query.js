const axios = require('axios');
const https = require('https');
const fs = require('fs');

async function test() {
    try {
        const configRaw = fs.readFileSync('config.json', 'utf8');
        const config = JSON.parse(configRaw);
        const { serviceLayerUrl, companyDB, userName, password } = config.sap;

        const agent = new https.Agent({ rejectUnauthorized: false });

        console.log('Logging in...');
        const loginRes = await axios.post(`${serviceLayerUrl}/Login`, {
            CompanyDB: companyDB,
            UserName: userName,
            Password: password,
            Language: 29
        }, { httpsAgent: agent });

        const cookies = loginRes.headers['set-cookie'];
        const cookieHeader = cookies.join('; ');
        console.log('Login successful.');

        const sqlCode = "QRY_OCNA_LIST";

        // 1. Delete if exists
        try {
            console.log(`Deleting existing query '${sqlCode}'...`);
            await axios.delete(`${serviceLayerUrl}/SQLQueries('${sqlCode}')`, {
                headers: { 'Cookie': cookieHeader },
                httpsAgent: agent
            });
            console.log('Deleted (or not found).');
        } catch (e) {
            console.log('Delete skipped/failed (might not exist):', e.message);
        }

        // 2. Create
        console.log(`Creating query '${sqlCode}'...`);
        const createBody = {
            "SqlCode": sqlCode,
            "SqlName": "OCNA - Lista CNAE",
            "SqlText": "SELECT \"AbsId\", \"CNAECode\", \"Descrip\" FROM \"OCNA\" ORDER BY \"CNAECode\""
        };

        try {
            await axios.post(`${serviceLayerUrl}/SQLQueries`, createBody, {
                headers: {
                    'Cookie': cookieHeader,
                    'Content-Type': 'application/json'
                },
                httpsAgent: agent
            });
            console.log('Query created successfully.');
        } catch (e) {
            console.error('Creation Failed:', e.message);
            if (e.response) console.error(JSON.stringify(e.response.data));
        }

        // 3. Execute
        console.log(`Executing query '${sqlCode}'...`);
        try {
            const listRes = await axios.get(`${serviceLayerUrl}/SQLQueries('${sqlCode}')/List`, {
                headers: { 'Cookie': cookieHeader },
                httpsAgent: agent
            });

            console.log('Execution Successful!');
            console.log('Record Count:', listRes.data.value ? listRes.data.value.length : 0);
            if (listRes.data.value && listRes.data.value.length > 0) {
                console.log('First Record:', JSON.stringify(listRes.data.value[0], null, 2));
            }
        } catch (e) {
            console.error('Execution Failed:', e.message);
            if (e.response) console.error(JSON.stringify(e.response.data));
        }

    } catch (error) {
        console.error('General Error:', error.message);
    }
}

test();
