import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { MailService } from './mail.service';
import { BlobStorageService } from './blob-storage.service';

@Module({
  providers: [PrismaService, MailService, BlobStorageService],
  exports: [PrismaService, MailService, BlobStorageService],
})
export default class SharedModule {}
