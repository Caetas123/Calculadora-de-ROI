import { startServer } from './api.js';

startServer().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
