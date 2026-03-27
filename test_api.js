const axios = require('axios');

async function run() {
    try {
        const url = 'http://127.0.0.1:3000/api/data?action=columns&table=stg_businesspartnergroups_14';
        console.log(`Fetching ${url}...`);
        const res = await axios.get(url);
        console.log('Success:', res.data);
    } catch (e) {
        console.error('Error:', e.message);
        if (e.response) {
            console.error('Response data:', e.response.data);
        }
    }
}

run();
