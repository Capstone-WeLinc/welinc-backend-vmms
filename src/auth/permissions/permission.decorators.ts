import { SetMetadata } from '@nestjs/common';

// Public session and health routes bypass the global person-token guard.
export const PUBLIC_KEY = 'public';
export const AUTHENTICATED_KEY = 'authenticated';
export const Public = () => SetMetadata(PUBLIC_KEY, true);
export const Authenticated = () => SetMetadata(AUTHENTICATED_KEY, true);
