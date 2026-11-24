import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env';
import { AssertionSigner } from './assertion-signer';
import { TOKEN_VERIFIER } from './guards';
import { ServiceTokenClient } from './service-token-client';
import { ResilientKeySet } from './key-set';
import { TokenVerifier } from './token-verifier';

/** The settings the token check needs. Each one missing stops the service at startup (AC-22). */
export type VerifyConfig = {
  issuer: string;
  jwksUrl: string;
  /** welinc-auth's address on the internal network, for `/auth/token` and other calls. */
  internalUrl: string;
  /** This service's client id at welinc-auth (`AUTH_CLIENT_ID`). */
  clientId: string;
};

export const VERIFY_CONFIG = Symbol('VERIFY_CONFIG');

/** Signs this service's client assertions with `AUTH_CLIENT_PRIVATE_KEY` (spec 0002, 0003). */
export const ASSERTION_SIGNER = Symbol('ASSERTION_SIGNER');

/** This service's token for welinc-auth's directory: `audience=AUTH`, `scope=directory.read`. */
export const DIRECTORY_TOKENS = Symbol('DIRECTORY_TOKENS');

/** This service's token for its permission matrix (suite spec 0013, AC-29): `scope=permissions.read`. */
export const PERMISSIONS_TOKENS = Symbol('PERMISSIONS_TOKENS');

/** VMMS's token for VRMS repair-referral writes. */
export const VRMS_REFERRAL_TOKENS = Symbol('VRMS_REFERRAL_TOKENS');

/** VMMS's token for VRMS repair status and history reads. */
export const VRMS_HISTORY_TOKENS = Symbol('VRMS_HISTORY_TOKENS');

/** VMMS's token for a live VRMS repair-ticket status read. */
export const VRMS_STATUS_TOKENS = Symbol('VRMS_STATUS_TOKENS');

/** VMMS's token for BMS vehicle-availability events. */
export const BMS_AVAILABILITY_TOKENS = Symbol('BMS_AVAILABILITY_TOKENS');

/** VMMS's token for BMS fleet-change invalidations. */
export const BMS_FLEET_CHANGE_TOKENS = Symbol('BMS_FLEET_CHANGE_TOKENS');

/** The audience this service accepts. Change it when copying the folder (`VMMS`, `BMS`). */
export const SERVICE_AUDIENCE = 'VMMS';

/** The boot check (spec 0010) refuses to start when any of these is missing (AC-22). */
export function readVerifyConfig(
  config: ConfigService<Env, true>,
): VerifyConfig {
  return {
    issuer: config.get('AUTH_ISSUER', { infer: true }),
    jwksUrl: config.get('AUTH_JWKS_URL', { infer: true }),
    internalUrl: config
      .get('AUTH_INTERNAL_URL', { infer: true })
      .replace(/\/+$/, ''),
    clientId: config.get('AUTH_CLIENT_ID', { infer: true }),
  };
}

/**
 * The token check, ready to inject anywhere: `TOKEN_VERIFIER` and `VERIFY_CONFIG`. Needs
 * `ConfigModule` loaded globally.
 */
@Global()
@Module({
  providers: [
    {
      provide: VERIFY_CONFIG,
      inject: [ConfigService],
      useFactory: readVerifyConfig,
    },
    {
      provide: TOKEN_VERIFIER,
      inject: [VERIFY_CONFIG],
      useFactory: (config: VerifyConfig) => {
        const logger = new Logger('AuthKeys');
        const keys = new ResilientKeySet({
          url: config.jwksUrl,
          onFetchError: (reason) =>
            logger.warn(`could not fetch welinc-auth's keys: ${reason}`),
        });
        return new TokenVerifier({
          issuer: config.issuer,
          audience: SERVICE_AUDIENCE,
          keys,
        });
      },
    },
    {
      provide: ASSERTION_SIGNER,
      inject: [VERIFY_CONFIG, ConfigService],
      // Async, so a missing or bad AUTH_CLIENT_PRIVATE_KEY stops startup (AC-22)
      useFactory: (verify: VerifyConfig, config: ConfigService<Env, true>) =>
        AssertionSigner.create({
          clientId: verify.clientId,
          privateKey: config.get('AUTH_CLIENT_PRIVATE_KEY', { infer: true }),
          issuer: verify.issuer,
        }),
    },
    {
      provide: DIRECTORY_TOKENS,
      inject: [VERIFY_CONFIG, ASSERTION_SIGNER],
      useFactory: (verify: VerifyConfig, signer: AssertionSigner) => {
        const logger = new Logger('ServiceToken');
        return new ServiceTokenClient({
          tokenUrl: `${verify.internalUrl}/auth/token`,
          signer,
          audience: 'AUTH',
          scope: 'directory.read',
          onError: (reason) =>
            logger.warn(`could not get a service token: ${reason}`),
        });
      },
    },
    {
      provide: PERMISSIONS_TOKENS,
      inject: [VERIFY_CONFIG, ASSERTION_SIGNER],
      useFactory: (verify: VerifyConfig, signer: AssertionSigner) => {
        const logger = new Logger('ServiceToken');
        return new ServiceTokenClient({
          tokenUrl: `${verify.internalUrl}/auth/token`,
          signer,
          audience: 'AUTH',
          scope: 'permissions.read',
          onError: (reason) =>
            logger.warn(`could not get a permissions token: ${reason}`),
        });
      },
    },
    {
      provide: VRMS_REFERRAL_TOKENS,
      inject: [VERIFY_CONFIG, ASSERTION_SIGNER],
      useFactory: (verify: VerifyConfig, signer: AssertionSigner) => {
        const logger = new Logger('ServiceToken');
        return new ServiceTokenClient({
          tokenUrl: `${verify.internalUrl}/auth/token`,
          signer,
          audience: 'VRMS',
          scope: 'repair.referral.write',
          onError: (reason) =>
            logger.warn(`could not get a VRMS referral token: ${reason}`),
        });
      },
    },
    {
      provide: VRMS_HISTORY_TOKENS,
      inject: [VERIFY_CONFIG, ASSERTION_SIGNER],
      useFactory: (verify: VerifyConfig, signer: AssertionSigner) => {
        const logger = new Logger('ServiceToken');
        return new ServiceTokenClient({
          tokenUrl: `${verify.internalUrl}/auth/token`,
          signer,
          audience: 'VRMS',
          scope: 'repair.history.read',
          onError: (reason) =>
            logger.warn(`could not get a VRMS history token: ${reason}`),
        });
      },
    },
    {
      provide: VRMS_STATUS_TOKENS,
      inject: [VERIFY_CONFIG, ASSERTION_SIGNER],
      useFactory: (verify: VerifyConfig, signer: AssertionSigner) => {
        const logger = new Logger('ServiceToken');
        return new ServiceTokenClient({
          tokenUrl: `${verify.internalUrl}/auth/token`,
          signer,
          audience: 'VRMS',
          scope: 'repair.status.read',
          onError: (reason) =>
            logger.warn(`could not get a VRMS status token: ${reason}`),
        });
      },
    },
    {
      provide: BMS_AVAILABILITY_TOKENS,
      inject: [VERIFY_CONFIG, ASSERTION_SIGNER],
      useFactory: (verify: VerifyConfig, signer: AssertionSigner) => {
        const logger = new Logger('ServiceToken');
        return new ServiceTokenClient({
          tokenUrl: `${verify.internalUrl}/auth/token`,
          signer,
          audience: 'BMS',
          scope: 'fleet.availability.write',
          onError: (reason) =>
            logger.warn(`could not get a BMS availability token: ${reason}`),
        });
      },
    },
    {
      provide: BMS_FLEET_CHANGE_TOKENS,
      inject: [VERIFY_CONFIG, ASSERTION_SIGNER],
      useFactory: (verify: VerifyConfig, signer: AssertionSigner) => {
        const logger = new Logger('ServiceToken');
        return new ServiceTokenClient({
          tokenUrl: `${verify.internalUrl}/auth/token`,
          signer,
          audience: 'BMS',
          scope: 'fleet.change.write',
          onError: (reason) =>
            logger.warn(`could not get a BMS fleet-change token: ${reason}`),
        });
      },
    },
  ],
  exports: [
    VERIFY_CONFIG,
    TOKEN_VERIFIER,
    ASSERTION_SIGNER,
    DIRECTORY_TOKENS,
    PERMISSIONS_TOKENS,
    VRMS_REFERRAL_TOKENS,
    VRMS_HISTORY_TOKENS,
    VRMS_STATUS_TOKENS,
    BMS_AVAILABILITY_TOKENS,
    BMS_FLEET_CHANGE_TOKENS,
  ],
})
export class AuthVerifyModule {}
