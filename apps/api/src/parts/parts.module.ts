import { Global, Module } from '@nestjs/common'
import { PartsController } from './parts.controller'
import { PartsService } from './parts.service'

@Global()
@Module({
  controllers: [PartsController],
  providers: [PartsService],
  exports: [PartsService],
})
export class PartsModule {}
