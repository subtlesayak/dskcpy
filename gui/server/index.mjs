import { createControlService } from './service.mjs';

const service = createControlService();
const shutdown = () => { void service.shutdown(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
try {
  const port = await service.listen();
  console.log('dskcpy control service: http://127.0.0.1:' + port);
} catch (error) {
  console.error(error.message);
  await service.shutdown();
  process.exitCode = 1;
}
