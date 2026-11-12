import { buildApp } from './app.js';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const app = await buildApp({ logger: process.env.LOG === '1' });
await app.listen({ port, host });
console.log(`BAMIGO draait op http://localhost:${port}  —  VAMOSSS!`);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await app.close(); process.exit(0); });
