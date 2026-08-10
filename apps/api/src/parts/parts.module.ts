import { Global, Module } from '@nestjs/common'
import { PartsController } from './parts.controller'
import { PartsProviderService } from './parts.provider'
import { PartsService } from './parts.service'

@Global()
@Module({
  controllers: [PartsController],
  providers: [PartsService, PartsProviderService],
  exports: [PartsService, PartsProviderService],
})
export class PartsModule {}
