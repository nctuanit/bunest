import { Module } from "@bunest/core";
import { CatsGuard } from "./cats.guard";
import { CatsResolver } from "./cats.resolver";
import { CatsService } from "./cats.service";
import { OwnersService } from "./owners.service";

@Module({
  providers: [CatsService, OwnersService, CatsGuard, CatsResolver],
})
export class CatsModule {}
