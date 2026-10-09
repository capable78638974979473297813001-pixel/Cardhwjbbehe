import { createApp } from './app.js';
import { openDb } from './db.js';

const port = Number(process.env.PORT ?? 3000);
const app = createApp({ db: openDb(process.env.DB_PATH ?? 'afterhours.sqlite') });

setInterval(() => app.purge(), 5 * 60 * 1000).unref();
app.server.listen(port, () => console.log(`AfterHours API listening on :${port}`));
