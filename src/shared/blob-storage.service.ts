import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import type { Env } from '../config/env';

export class StorageUnavailableException extends ServiceUnavailableException {
  constructor() {
    super({
      statusCode: 503,
      code: 'STORAGE_UNAVAILABLE',
      message: 'File storage is not available right now.',
    });
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'statusCode' in error && (error as { statusCode?: unknown }).statusCode === 404;
}

/** Private object storage for attachments. Local development uses Azurite; Azure uses managed identity. */
@Injectable()
export class BlobStorageService implements OnModuleInit {
  private readonly logger = new Logger(BlobStorageService.name);
  private readonly container: ContainerClient | null;
  private ready = false;

  constructor(config: ConfigService<Env, true>) {
    const connectionString = config.get('STORAGE_CONNECTION_STRING', { infer: true })?.trim();
    const accountUrl = config.get('STORAGE_ACCOUNT_URL', { infer: true })?.trim();
    const containerName = config.get('STORAGE_CONTAINER', { infer: true })?.trim() || 'vmms-uploads';

    // Load the Azure SDK only when blob storage is configured. Besides keeping
    // local unit tests independent of cloud SDK module formats, this lets
    // non-storage workflows run when no storage account is configured.
    let service: BlobServiceClient | null = null;
    if (connectionString) {
      const { BlobServiceClient: AzureBlobServiceClient } = require('@azure/storage-blob') as typeof import('@azure/storage-blob');
      service = AzureBlobServiceClient.fromConnectionString(connectionString);
    } else if (accountUrl) {
      const { BlobServiceClient: AzureBlobServiceClient } = require('@azure/storage-blob') as typeof import('@azure/storage-blob');
      const { DefaultAzureCredential } = require('@azure/identity') as typeof import('@azure/identity');
      service = new AzureBlobServiceClient(accountUrl, new DefaultAzureCredential());
    }
    this.container = service?.getContainerClient(containerName) ?? null;
  }

  async onModuleInit(): Promise<void> {
    if (this.container) await this.ensureContainer(false);
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const container = await this.requireContainer();
    await container.getBlockBlobClient(key).uploadData(body, {
      blobHTTPHeaders: { blobContentType: contentType },
    });
  }

  async get(key: string): Promise<Buffer> {
    const container = await this.requireContainer();
    try {
      return await container.getBlockBlobClient(key).downloadToBuffer();
    } catch (error) {
      if (isNotFound(error)) throw new NotFoundException('Attachment not found.');
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const container = await this.requireContainer();
    await container.getBlobClient(key).deleteIfExists();
  }

  private async requireContainer(): Promise<ContainerClient> {
    if (!this.container) throw new StorageUnavailableException();
    if (!this.ready) await this.ensureContainer(true);
    return this.container;
  }

  private async ensureContainer(failRequest: boolean): Promise<void> {
    try {
      // No public access level is set: containers are private by default.
      await this.container!.createIfNotExists();
      this.ready = true;
    } catch {
      this.logger.warn('Blob storage is not reachable; attachment requests will retry it.');
      if (failRequest) throw new StorageUnavailableException();
    }
  }
}
