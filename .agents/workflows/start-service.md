---
description: Ensure the service is running on the correct port before proceeding
---
1. Run `lsof -i :3003` to check if the service is already active.
2. If it is active, do not start a new one. Log that you are using the existing instance.
3. If it is not active:
   // turbo
   a. Check if `pm2` is installed. If yes, run `npm run pm2:start`.
   b. If `pm2` is not installed, run `npm run dev` in the background and wait for it to be ready.
4. Verify the service is accessible at http://127.0.0.1:3003.
