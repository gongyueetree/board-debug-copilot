import { Module } from '@nestjs/common'
import { StorageService } from '../storage/storage.service'
import { KicadController } from './kicad.controller'
import { KicadService } from './kicad.service'

@Module({
  controllers: [KicadController],
  providers: [KicadService, StorageService],
  exports: [KicadService],
})
export class KicadModule {}
