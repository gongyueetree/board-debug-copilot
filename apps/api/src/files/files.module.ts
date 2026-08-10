import { Module } from '@nestjs/common'
import { StorageService } from '../storage/storage.service'
import { FilesController } from './files.controller'

@Module({
  controllers: [FilesController],
  providers: [StorageService],
})
export class FilesModule {}
