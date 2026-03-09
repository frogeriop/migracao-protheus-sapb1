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

        console.log('Fetching Metadata...');
        const metadataRes = await axios.get(`${serviceLayerUrl}/$metadata`, {
            headers: { 'Cookie': cookieHeader },
            httpsAgent: agent,
            responseType: 'text'
        });
        const metadata = metadataRes.data;

        // Find all EntitySets
        const regex = /<EntitySet Name="([^"]+)"/g;
        let match;
        const sets = [];
        while ((match = regex.exec(metadata)) !== null) {
            sets.push(match[1]);
        }

        console.log(`Total EntitySets found: ${sets.length}`);

        const cnaeSets = sets.filter(s => s.toUpperCase().includes('CNAE'));
        console.log('EntitySets with CNAE:', cnaeSets);

        const ocnaSets = sets.filter(s => s.toUpperCase().includes('OCNA'));
        console.log('EntitySets with OCNA:', ocnaSets);

        // Also just dump first few to sanity check
        console.log('First 10 EntitySets:', sets.slice(0, 10));

    } catch (error) {
        console.error('Error:', error.message);
    }
}

test();
