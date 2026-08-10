import { Module } from '@nestjs/common'
import { StorageService } from '../storage/storage.service'
import { FilesController } from './files.controller'

// AuthService 由 @Global 的 AuthModule 提供，这里不用再 import
@Module({
  controllers: [FilesController],
  providers: [StorageService],
})
export class FilesModule {}
