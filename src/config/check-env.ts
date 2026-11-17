import 'dotenv/config';
import { validateEnv } from './env';

try {
  validateEnv(process.env);
  console.log('Environment check passed');
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Environment check failed',
  );
  process.exit(1);
}
